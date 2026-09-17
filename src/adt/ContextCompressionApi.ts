/**
 * ============================================================================
 * 依赖上下文压缩只读 API（补齐能力矩阵 codeintel.context 的 dependency-context-spike）
 * ============================================================================
 *
 * 回答"读这个对象之前，我需要先知道它引用的哪些东西长什么样"。给定一个对象的
 * 源码，正则提取其外部依赖（父类/实现接口/协作类/函数模块/异常类），按"读者
 * 需要什么"排序，逐个经 ADT 取回源码并压缩成公共契约（类只留 PUBLIC SECTION、
 * 接口全量、函数模块只留签名），最后拼装成一段可读的 prologue 文本。
 *
 * 参考实现：VSP vibing-steampunk pkg/ctxcomp（compressor.go/deps.go/candidates.go/
 * contract.go/methodlevel.go）与 internal/mcp/handlers_context.go、handlers_effects.go
 * （本文件逐段注明 VSP 来源行号；VSP 仓库只读，未做任何修改）。
 *
 * 业务规则：
 *   - 纯只读：唯一 SAP 交互是取依赖对象源码（searchObject → objectStructure →
 *     getObjectSource 三步，全部 GET 语义），无任何写操作、无锁、无激活。
 *   - 串行取源：VSP 用 5 路并发（compressor.go L163），本项目保持 SAP 调用串行
 *     的产品红线（AGENTS.md：真实 SAP 调用保持串行），一次取一个依赖。
 *   - 失败是答案的一部分：取不到的依赖不悄悄丢弃，而是进 unresolved 名单一并
 *     报告（compressor.go L243-252 的"命名而非丢弃"原则）——被静默丢掉的名字
 *     会让残缺上下文看起来像完整上下文。
 *   - 预算按"到手的契约"计算而不是按"尝试过的名字"：失败消耗一次取数而不是
 *     一个槽位（compressor.go L96-107 注释）。
 *   - parse/effects 两个子能力是纯客户端文本分析，零 SAP 往返。
 */

/** 依赖种类：VSP DependencyKind（types.go L8-12）只有 CLAS/INTF/FUNC 三类。 */
export type DependencyKind = 'CLAS' | 'INTF' | 'FUNC'

/**
 * 顶层对象的取源类型：在依赖三分类之外增加 PROG——顶层被分析对象可以是一个
 * 报表程序，但依赖展开（第二层及以后）只会产生 CLAS/INTF/FUNC。
 */
export type SourceKind = DependencyKind | 'PROG'

/** 单个外部依赖：源码里引用到的一个外部对象（VSP types.go L15-26）。 */
export interface Dependency {
  /** 依赖对象名（统一大写，含命名空间斜杠，如 /DMF/CL_FOO）。 */
  name: string
  /** 依赖种类：类/接口/函数模块。 */
  kind: DependencyKind
  /** 源码中首次发现该依赖的行号（1-based，仅分析层有，压缩层不填）。 */
  line?: number
  /**
   * 本源码在该依赖上调用的方法名清单（VSP types.go L20-25）：空数组表示
   * "什么都没查到"——这与"查到了但没有调用"不同，契约随后者保持完整、
   * 随前者按调用收窄（methodlevel.go L9-13）。
   */
  methods?: string[]
}

/** 依赖的压缩公共契约（VSP types.go L29-40）。 */
export interface Contract {
  /** 依赖对象名。 */
  name: string
  /** 依赖种类。 */
  kind: DependencyKind
  /** 压缩后的公共 API 文本（类=PUBLIC SECTION；接口=全量；FM=签名）。 */
  source: string
  /** 该依赖公开面共有多少个方法声明。 */
  methodsTotal: number
  /** 收窄后实际展示多少个（本源码调用的那些）。 */
  methodsShown: number
  /** 非空表示解析失败（该依赖进 unresolved 名单而非契约清单）。 */
  error?: string
}

/** 压缩统计（VSP types.go L43-49）。 */
export interface ContextStats {
  /** 报告的依赖总数（含未解析的）。 */
  depsFound: number
  /** 成功取得契约的依赖数。 */
  depsResolved: number
  /** 解析失败的依赖数。 */
  depsFailed: number
  /** prologue 文本行数。 */
  totalLines: number
}

/** getDependencyContext 的返回（对齐 VSP ContextResult + Stats 透出）。 */
export interface GetDependencyContextResult {
  /** 规范化（大写）后的分析对象名。 */
  objectName: string
  /** 规范化后的对象类型。 */
  objectType: SourceKind
  /** 拼装好的依赖上下文文本（* 开头行是注释性说明）。 */
  prologue: string
  /** 压缩统计。 */
  stats: ContextStats
  /** 未取得契约的依赖名（prologue 中已罗列，这里结构化透出便于程序消费）。 */
  unresolved: string[]
}

/* ==========================================================================
 * 依赖提取（正则层，VSP deps.go L8-158 的逐条移植）
 * ========================================================================== */

/**
 * ABAP 对象名模式：字母或命名空间斜杠开头，后接字母/数字/下划线/斜杠
 * （VSP deps.go L6 namePattern）。
 */
const NAME_PATTERN = '[a-zA-Z/][a-zA-Z0-9_/]*'

// 依赖发现的全部正则（VSP deps.go L8-31，逐条对齐；Go 的 (?i) 换成 JS i 标志）：
const RE_TYPE_REF_TO = new RegExp(`\\bTYPE\\s+REF\\s+TO\\s+(${NAME_PATTERN})`, 'gi')
const RE_NEW = new RegExp(`\\bNEW\\s+(${NAME_PATTERN})\\s*\\(`, 'gi')
const RE_STATIC_CALL = new RegExp(`(${NAME_PATTERN})=>`, 'gi')
const RE_INTF_METHOD = new RegExp(`(${NAME_PATTERN})~`, 'gi')
const RE_INHERITING = new RegExp(`\\bINHERITING\\s+FROM\\s+(${NAME_PATTERN})`, 'gi')
const RE_INTERFACES = new RegExp(`\\bINTERFACES\\s+(${NAME_PATTERN})`, 'gi')
const RE_CALL_FUNCTION = /\bCALL\s+FUNCTION\s+'([^']+)'/gi
const RE_CAST = new RegExp(`\\bCAST\\s+(${NAME_PATTERN})\\s*\\(`, 'gi')
// CREATE OBJECT lo_x TYPE zcl_thing：7.40 之前的经典实例化写法；裸 CREATE OBJECT
// 不点名类（类型来自变量声明，TYPE REF TO 已覆盖），无需单独识别（deps.go L20-27）。
const RE_CREATE_OBJECT = new RegExp(`\\bCREATE\\s+OBJECT\\s+(${NAME_PATTERN})\\s+TYPE\\s+(${NAME_PATTERN})`, 'gi')
const RE_RAISING = new RegExp(`\\bRAISING\\s+(${NAME_PATTERN})`, 'gi')
// 异常类裸引用（ZCX_*/YCX_* 常常单独成行出现在 RAISING 之后；deps.go L30-31）
const RE_EXCEPTION_REF = /\b(z[a-z]*cx_[a-z0-9_]+|ycx_[a-z0-9_]+)/gi

/**
 * ABAP 内建类型：永远不作为依赖报告（VSP deps.go L34-43 builtinTypes）。
 */
const BUILTIN_TYPES = new Set([
  'STRING', 'I', 'C', 'N', 'D', 'T', 'X', 'XSTRING',
  'ABAP_BOOL', 'ABAP_TRUE', 'ABAP_FALSE',
  'ANY', 'DATA', 'REF', 'OBJECT', 'INT8', 'DECFLOAT16', 'DECFLOAT34',
  'P', 'F', 'CLIKE', 'CSEQUENCE', 'XSEQUENCE', 'NUMERIC', 'SIMPLE'
])

/**
 * SAP 标准前缀黑名单：这些内核类型体量巨大且对上下文压缩没有价值
 * （VSP deps.go L46-51 standardSkipPrefixes）。
 */
const STANDARD_SKIP_PREFIXES = ['CL_ABAP_', 'IF_ABAP_', 'CX_SY_', 'CX_DYNAMIC_CHECK', 'CX_STATIC_CHECK', 'CX_NO_CHECK']

/**
 * 从 ABAP 源码提取外部依赖（VSP deps.go L58-116 ExtractDependencies）。
 *
 * 逐行扫描（跳过整行注释），十类正则各司其职；按名字去重；当"类"与"接口"
 * 证据冲突时接口胜出（INTERFACES 关键字是更强证据，deps.go L127-131）。
 */
export function extractDependencies(source: string): Dependency[] {
  const seen = new Map<string, Dependency>()
  const lines = source.split('\n')

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    const lineNum = lineIdx + 1
    // 整行注释（* 或 "开头）不产生依赖（deps.go L66-69）
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('"')) continue

    for (const m of matchAll(RE_TYPE_REF_TO, line)) addDep(seen, m[1], inferKind(m[1]), lineNum)
    for (const m of matchAll(RE_NEW, line)) addDep(seen, m[1], 'CLAS', lineNum)
    for (const m of matchAll(RE_STATIC_CALL, line)) addDep(seen, m[1], inferKind(m[1]), lineNum)
    for (const m of matchAll(RE_INTF_METHOD, line)) addDep(seen, m[1], 'INTF', lineNum)
    for (const m of matchAll(RE_INHERITING, line)) addDep(seen, m[1], 'CLAS', lineNum)
    for (const m of matchAll(RE_INTERFACES, line)) addDep(seen, m[1], 'INTF', lineNum)
    for (const m of matchAll(RE_CALL_FUNCTION, line)) addDep(seen, m[1], 'FUNC', lineNum)
    for (const m of matchAll(RE_CAST, line)) addDep(seen, m[1], inferKind(m[1]), lineNum)
    // CREATE OBJECT <变量> TYPE <类名>：第二个捕获组才是类名，第一个是接收变量
    for (const m of matchAll(RE_CREATE_OBJECT, line)) addDep(seen, m[2], inferKind(m[2]), lineNum)
    for (const m of matchAll(RE_RAISING, line)) addDep(seen, m[1], 'CLAS', lineNum)
    for (const m of matchAll(RE_EXCEPTION_REF, line)) addDep(seen, m[1], 'CLAS', lineNum)
  }
  return [...seen.values()]
}

/** RegExp 全局匹配的迭代器转数组工具（Go FindAllStringSubmatch 的等价物）。 */
function matchAll(re: RegExp, line: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  // 每次调用重置 lastIndex，保证同一正则可在多行间安全复用
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    out.push(m)
    // 零宽匹配防护：手动前进一格避免死循环
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/** 记录一个依赖：跳过黑名单；同名去重；接口证据覆盖类证据（deps.go L118-131）。 */
function addDep(seen: Map<string, Dependency>, name: string, kind: DependencyKind, line: number): void {
  const upper = name.toUpperCase()
  if (shouldSkip(upper)) return
  const existing = seen.get(upper)
  if (!existing) {
    seen.set(upper, { name: upper, kind, line })
  } else if (kind === 'INTF' && existing.kind === 'CLAS') {
    existing.kind = 'INTF'
  }
}

/** 内建类型与标准前缀黑名单判定（deps.go L133-141 shouldSkip）。 */
function shouldSkip(name: string): boolean {
  if (BUILTIN_TYPES.has(name)) return true
  return STANDARD_SKIP_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * 按命名约定猜测对象是类还是接口（deps.go L143-158 inferKind）：
 * ZIF_ / YIF_ / IF_ 前缀是接口；命名空间对象的末段以 IF_ 开头也算接口；其余按类。
 */
function inferKind(name: string): DependencyKind {
  const upper = name.toUpperCase()
  if (upper.startsWith('ZIF_') || upper.startsWith('YIF_') || upper.startsWith('IF_')) {
    return 'INTF'
  }
  const slash = upper.lastIndexOf('/')
  if (slash >= 0 && upper.slice(slash + 1).startsWith('IF_')) return 'INTF'
  return 'CLAS'
}

/* ==========================================================================
 * 候选排序（VSP candidates.go：预算之下"读者需要什么先给什么"）
 * ========================================================================== */

/**
 * 依赖角色（VSP candidates.go L28-47）：数值即排序优先级——
 *   1 义务（父类/实现接口，不读不懂）→ 2 签名类型（公共 API 里出现的类型）
 *   → 3 协作者（调用的类，按使用频次）→ 4 异常（预算耗尽时最先舍弃）。
 * 0 是"未分类"哨兵值，保证零值不构成合法角色（candidates.go L21-27 的教训）。
 */
const ROLE_UNCLASSIFIED = 0
const ROLE_OBLIGATION = 1
const ROLE_SIGNATURE = 2
const ROLE_COLLABORATOR = 3
const ROLE_EXCEPTION = 4

/** 排序用注记：角色 + 出现次数 + 是否自定义对象（candidates.go L52-58）。 */
interface RankedDep {
  dependency: Dependency
  role: number
  uses: number
  custom: boolean
}

// 义务识别正则：对大写化后的源码匹配（candidates.go L60-62）
const RE_INHERITS_FROM = /\bINHERITING\s+FROM\s+([A-Z_/0-9]+)/g
const RE_IMPLEMENTS = /^\s*INTERFACES\s+([A-Z_/0-9]+)/

/**
 * 自定义对象判定：Z/Y 开头（含命名空间 /Z、/Y；VSP compressor.go L198-201）。
 */
function isCustom(name: string): boolean {
  return name.startsWith('Z') || name.startsWith('Y') || name.startsWith('/Z') || name.startsWith('/Y')
}

/**
 * 异常类判定：SAP 自身命名约定是唯一可用信号（candidates.go L131-146
 * isExceptionClass）：CX_/ZCX_/YCX_//ZCX_ 前缀，或命名空间 /X/CX_FOO 形态。
 */
function isExceptionClass(name: string): boolean {
  const n = name.toUpperCase()
  for (const p of ['CX_', 'ZCX_', 'YCX_', '/ZCX_']) {
    if (n.startsWith(p)) return true
  }
  if (n.startsWith('/')) {
    const i = n.slice(1).indexOf('/')
    if (i > 0) return n.slice(i + 2).startsWith('CX_')
  }
  return false
}

/**
 * 依赖排序（VSP candidates.go L82-127 RankCandidates）。
 *
 * 行序不是重要性度量——它会把只被引用一次的类型排到父类前面（父类在第二行
 * 就出现了）。这里的次序是读者理解代码的次序：义务 → 签名 → 协作者 → 异常；
 * 同带内自定义对象优先（读者认识 CL_ABAP_TYPEDESCR，不认识 ZCL_VSP_GIT_SERVICE）。
 * 次数按"出现次数"计而非"行数"：一行里三次调用就是三次。
 */
export function rankCandidates(source: string, deps: Dependency[]): RankedDep[] {
  const upper = source.toUpperCase()
  const lines = upper.split('\n')

  // 义务集合 = 父类（INHERITING FROM）+ 实现接口（行首 INTERFACES）
  const obligations = new Set<string>()
  for (const m of matchAll(RE_INHERITS_FROM, upper)) obligations.add(m[1])
  for (const line of lines) {
    const m = RE_IMPLEMENTS.exec(line)
    if (m) obligations.add(m[1])
  }

  // 公共段终点：第一处 PROTECTED/PRIVATE SECTION——之前出现的名字是调用方可见的
  let publicEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('PROTECTED SECTION') || t.startsWith('PRIVATE SECTION')) {
      publicEnd = i
      break
    }
  }

  const out: RankedDep[] = []
  for (const d of deps) {
    const r: RankedDep = { dependency: d, role: ROLE_UNCLASSIFIED, uses: 0, custom: isCustom(d.name) }
    for (let i = 0; i < lines.length; i++) {
      const n = countOccurrences(lines[i], d.name)
      if (n === 0) continue
      r.uses += n
      if (i < publicEnd) r.role = ROLE_SIGNATURE
    }
    if (obligations.has(d.name)) {
      r.role = ROLE_OBLIGATION
    } else if (isExceptionClass(d.name)) {
      r.role = ROLE_EXCEPTION
    } else if (r.role !== ROLE_SIGNATURE) {
      r.role = ROLE_COLLABORATOR
    }
    out.push(r)
  }

  // 稳定排序：角色升序 → 自定义优先 → 使用次数降序 → 首现行号升序
  out.sort((a, b) => {
    if (a.role !== b.role) return a.role - b.role
    if (a.custom !== b.custom) return a.custom ? -1 : 1
    if (a.uses !== b.uses) return b.uses - a.uses
    return (a.dependency.line ?? 0) - (b.dependency.line ?? 0)
  })
  return out
}

/** 子串出现次数（Go strings.Count 语义：重叠不计）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = haystack.indexOf(needle)
  while (pos >= 0) {
    count++
    pos = haystack.indexOf(needle, pos + needle.length)
  }
  return count
}

/* ==========================================================================
 * 公共契约提取（VSP contract.go 的逐条移植）
 * ========================================================================== */

// 类契约提取用正则（contract.go L7-16）
const RE_CLASS_DEF = /^\s*CLASS\s+\S+\s+DEFINITION/i
const RE_PUBLIC_SECTION = /^\s*PUBLIC\s+SECTION\s*\./i
const RE_PROTECTED_SECTION = /^\s*PROTECTED\s+SECTION\s*\./i
const RE_PRIVATE_SECTION = /^\s*PRIVATE\s+SECTION\s*\./i
const RE_END_CLASS = /^\s*ENDCLASS\s*\./i
const RE_CLASS_IMPL = /^\s*CLASS\s+\S+\s+IMPLEMENTATION\s*\./i
const RE_INTERFACE_DEF = /^\s*INTERFACE\s+\S+/i
const RE_END_INTERFACE = /^\s*ENDINTERFACE\s*\./i
const RE_FUNCTION_START = /^\s*FUNCTION\s+/i
const RE_END_FUNCTION = /^\s*ENDFUNCTION\s*\./i
// FM 源码顶部的 *" 签名注释块（contract.go L16 reFMComment）
const RE_FM_COMMENT = /^\*"/

/**
 * 从完整源码提取公共 API 面（contract.go L29-40 ExtractContract）：
 * 类 = DEFINITION 行 + PUBLIC SECTION；接口 = 全量定义；函数模块 = 签名注释与
 * 参数关键字段。
 */
export function extractContract(source: string, kind: DependencyKind): string {
  switch (kind) {
    case 'CLAS': return extractClassContract(source)
    case 'INTF': return extractInterfaceContract(source)
    case 'FUNC': return extractFMContract(source)
  }
}

/**
 * 类契约：CLASS DEFINITION 起、PUBLIC SECTION 止；遇到 PROTECTED/PRIVATE
 * SECTION 时补一行 ENDCLASS. 保持文本语法完整（contract.go L42-100）。
 */
function extractClassContract(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  // 状态机：找 DEFINITION → 在定义内 → 在公共段内 → 完成
  const SEARCHING_DEF = 0, IN_DEF = 1, IN_PUBLIC = 2, DONE = 3
  let state = SEARCHING_DEF

  for (const line of lines) {
    if (state === SEARCHING_DEF) {
      if (RE_CLASS_IMPL.test(line)) {
        state = DONE // 先撞到 IMPLEMENTATION——没有独立定义段可取
      } else if (RE_CLASS_DEF.test(line)) {
        out.push(line)
        state = IN_DEF
      }
    } else if (state === IN_DEF) {
      out.push(line)
      if (RE_PUBLIC_SECTION.test(line)) {
        state = IN_PUBLIC
      } else if (RE_END_CLASS.test(line)) {
        state = DONE // 没有公共段的定义型类
      }
    } else if (state === IN_PUBLIC) {
      if (RE_PROTECTED_SECTION.test(line) || RE_PRIVATE_SECTION.test(line)) {
        out.push('ENDCLASS.')
        state = DONE
      } else if (RE_END_CLASS.test(line)) {
        out.push(line)
        state = DONE
      } else {
        // 空行与纯注释行不进契约（压缩优先）
        const trimmed = line.trim()
        if (trimmed === '') continue
        out.push(line)
      }
    }
    if (state === DONE) break
  }
  return out.length === 0 ? '' : out.join('\n')
}

/** 接口契约：INTERFACE 行到 ENDINTERFACE 的全量文本（contract.go L102-126）。 */
function extractInterfaceContract(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inInterface = false
  for (const line of lines) {
    if (!inInterface) {
      if (RE_INTERFACE_DEF.test(line)) {
        inInterface = true
        out.push(line)
      }
      continue
    }
    out.push(line)
    if (RE_END_INTERFACE.test(line)) break
  }
  return out.length === 0 ? '' : out.join('\n')
}

/**
 * 函数模块契约：FUNCTION 行 + *" 签名注释块 + IMPORTING/EXPORTING/CHANGING/
 * TABLES/EXCEPTIONS/RAISING 参数行，收在补写的 ENDFUNCTION.（contract.go
 * L128-183）。没有 *" 注释块的 FM 靠参数关键字行兜底。
 */
function extractFMContract(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFunction = false
  let inSignatureComments = false
  let pastSignature = false

  for (const line of lines) {
    if (!inFunction) {
      if (RE_FUNCTION_START.test(line)) {
        inFunction = true
        out.push(line)
      }
      continue
    }
    if (pastSignature) break
    if (RE_FM_COMMENT.test(line)) {
      inSignatureComments = true
      out.push(line)
      continue
    }
    // 签名注释块之后遇到非注释行：签名结束
    if (inSignatureComments) {
      pastSignature = true
      continue
    }
    const trimmed = line.trim().toUpperCase()
    if (
      trimmed.startsWith('IMPORTING') || trimmed.startsWith('EXPORTING')
      || trimmed.startsWith('CHANGING') || trimmed.startsWith('TABLES')
      || trimmed.startsWith('EXCEPTIONS') || trimmed.startsWith('RAISING')
    ) {
      out.push(line)
      continue
    }
    if (RE_END_FUNCTION.test(line)) break
    // 参数区之外的正文行：签名到此为止
    pastSignature = true
  }
  if (out.length === 0) return ''
  out.push('ENDFUNCTION.')
  return out.join('\n')
}

/* ==========================================================================
 * 方法级收窄（VSP methodlevel.go：宽接口窄使用的去噪）
 * ========================================================================== */

// 调用识别正则（methodlevel.go L14-19，对大写化源码匹配）：
const RE_INSTANCE_CALL = /\b([A-Z_][A-Z_0-9]*)\s*->\s*([A-Z_][A-Z_0-9]*)\s*\(/g
const RE_STATIC_METHOD = /\b([A-Z_/][A-Z_0-9/]*)\s*=>\s*([A-Z_][A-Z_0-9]*)\s*\(/g
const RE_INTF_CALL = /\b([A-Z_/][A-Z_0-9/]*)\s*~\s*([A-Z_][A-Z_0-9]*)\s*\(/g
// 接收者变量 → 声明类型的纽带（methodlevel.go L19-20）
const RE_TYPED_REF = /\b([A-Z_][A-Z_0-9]*)\s+TYPE\s+REF\s+TO\s+([A-Z_/][A-Z_0-9/]*)/g

/**
 * 按依赖名归集本源码在其上调用的方法（methodlevel.go L25-66 MethodsCalledOn）。
 *
 * 实例调用经变量转发，须先查变量的声明类型；声明不在本源码中的接收者直接
 * 跳过而不猜——把方法记到错误的类上，比契约宽一点糟糕得多。
 */
export function methodsCalledOn(source: string): Map<string, string[]> {
  const upper = source.toUpperCase()
  const typeOf = new Map<string, string>()
  for (const m of matchAll(RE_TYPED_REF, upper)) typeOf.set(m[1], m[2])

  const out = new Map<string, Set<string>>()
  const add = (owner: string, method: string) => {
    if (!owner || !method) return
    let set = out.get(owner)
    if (!set) {
      set = new Set<string>()
      out.set(owner, set)
    }
    set.add(method)
  }
  for (const m of matchAll(RE_INSTANCE_CALL, upper)) {
    const owner = typeOf.get(m[1])
    if (owner) add(owner, m[2])
  }
  for (const m of matchAll(RE_STATIC_METHOD, upper)) add(m[1], m[2])
  for (const m of matchAll(RE_INTF_CALL, upper)) add(m[1], m[2])

  const result = new Map<string, string[]>()
  for (const [owner, methods] of out) result.set(owner, [...methods])
  return result
}

/**
 * 契约收窄：只保留 wanted 方法声明，其余方法声明丢弃；方法声明之外的行
 * （类/接口头、类型、常量、数据）一律保留——那是存活签名所依赖的词汇表
 * （methodlevel.go L76-120 NarrowContract）。
 *
 * 空名单 = 无调用信息，契约原样返回：在零信息上收窄就是猜。
 *
 * @returns [收窄文本, 契约方法总数, 展示数]
 */
export function narrowContract(contract: string, want: readonly string[]): [string, number, number] {
  if (contract.trim() === '') return [contract, 0, 0]
  const wanted = new Set(want.map(w => w.trim().toUpperCase()))

  const lines = contract.split('\n')
  const out: string[] = []
  let inMethod = false
  let keepThis = false
  let total = 0
  let kept = 0

  for (const line of lines) {
    const upper = line.toUpperCase()
    const trimmed = upper.trim()

    const declName = methodDeclName(trimmed)
    if (declName !== undefined) {
      total++
      inMethod = true
      keepThis = wanted.size === 0 || wanted.has(declName)
      if (keepThis) {
        kept++
        out.push(line)
      }
      if (trimmed.endsWith('.')) inMethod = false
      continue
    }

    if (inMethod) {
      // 刚才那行声明的续行，去留同进退
      if (keepThis) out.push(line)
      if (trimmed.endsWith('.')) inMethod = false
      continue
    }
    out.push(line)
  }

  if (wanted.size === 0) return [contract, total, total]
  return [out.join('\n'), total, kept]
}

/**
 * 判断一行是否开启方法声明并返回方法名（methodlevel.go L125-146
 * methodDeclName）；返回 undefined 表示不是方法声明行。
 * METHODS: a, b, c 链式声明的收窄会产出非法 ABAP，整体保留。
 */
function methodDeclName(trimmed: string): string | undefined {
  for (const kw of ['METHODS ', 'CLASS-METHODS ']) {
    if (!trimmed.startsWith(kw)) continue
    const rest = trimmed.slice(kw.length).trim()
    if (rest.startsWith(':')) return undefined
    let name = rest
    const cut = name.search(/[ \t.]/)
    if (cut > 0) name = name.slice(0, cut)
    if (!name) return undefined
    return name
  }
  return undefined
}

/* ==========================================================================
 * ABAP 词法与分句（VSP handlers_context.go tokenizeLine/classifyStatement 的移植）
 * ========================================================================== */

/** 词法单元：文本 + 种类 + 行号（handlers_context.go L243-249 abapToken）。 */
export interface AbapToken {
  str: string
  type: 'identifier' | 'punctuation' | 'string' | 'arrow'
  row: number
}

/** 一条语句：分类 + 全部词元 + 首关键字（handlers_context.go L52-57）。 */
export interface AbapStatement {
  type: string
  tokens: AbapToken[]
  first: string
}

/**
 * 把一行 ABAP 切成词元（handlers_context.go L166-240 tokenizeLine）：
 * 尊重 ' ` | 三种字符串字面量（含 '' 转义），标点单列，-> 与 => 成箭头词元。
 */
export function tokenizeLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inString = false
  let stringChar = ''

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      current += ch
      if (ch === stringChar) {
        // 成对引号是字面量内的转义，不是字符串结束
        if (i + 1 < line.length && line[i + 1] === stringChar) {
          current += line[i + 1]
          i++
          continue
        }
        inString = false
        flush()
      }
      continue
    }
    switch (ch) {
      case "'":
      case '`':
        flush()
        inString = true
        stringChar = ch
        current += ch
        break
      case '|': {
        // 字符串模板：吞到配对的 |（反斜杠转义不计）
        flush()
        current += ch
        i++
        for (; i < line.length; i++) {
          current += line[i]
          if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) break
        }
        flush()
        break
      }
      case ' ':
      case '\t':
        flush()
        break
      case '.':
      case ',':
      case ':':
      case '(':
      case ')':
      case '[':
      case ']':
        flush()
        tokens.push(ch)
        break
      case '-':
        if (i + 1 < line.length && line[i + 1] === '>') {
          flush()
          tokens.push('->')
          i++
        } else {
          current += ch
        }
        break
      case '=':
        if (i + 1 < line.length && line[i + 1] === '>') {
          flush()
          tokens.push('=>')
          i++
        } else {
          flush()
          tokens.push('=')
        }
        break
      default:
        current += ch
    }
  }
  flush()
  return tokens
}

/**
 * 词元种类标注（handlers_context.go L105-112）：标点/字符串/箭头/标识符。
 */
function tokenType(word: string): AbapToken['type'] {
  if (word === '.' || word === ',' || word === ':') return 'punctuation'
  if (word.startsWith("'") || word.startsWith('`') || word.startsWith('|')) return 'string'
  if (word === '->' || word === '=>') return 'arrow'
  return 'identifier'
}

/**
 * 语句分类（handlers_context.go L247-350 classifyStatement 的逐条移植）：
 * 按首关键字给出 DATA/SQL/LOOP/CLASS_DEFINITION/CALL_FUNCTION 等粗分类。
 */
export function classifyStatement(tokens: AbapToken[]): string {
  if (tokens.length === 0) return 'EMPTY'
  if (tokens.length === 1 && tokens[0].str === '.') return 'EMPTY'
  const first = tokens[0].str.toUpperCase()
  switch (first) {
    case 'DATA': case 'TYPES': case 'CONSTANTS': case 'STATICS':
    case 'FIELD-SYMBOLS': case 'TABLES':
      return 'DATA'
    case 'CLASS': {
      if (tokens.length > 2) {
        const third = tokens[2].str.toUpperCase()
        if (third === 'DEFINITION') return 'CLASS_DEFINITION'
        if (third === 'IMPLEMENTATION') return 'CLASS_IMPLEMENTATION'
      }
      return 'CLASS'
    }
    case 'ENDCLASS': return 'ENDCLASS'
    case 'METHOD': return 'METHOD'
    case 'ENDMETHOD': return 'ENDMETHOD'
    case 'INTERFACE': return 'INTERFACE'
    case 'ENDINTERFACE': return 'ENDINTERFACE'
    case 'IF': case 'ELSEIF': return 'IF'
    case 'ELSE': return 'ELSE'
    case 'ENDIF': return 'ENDIF'
    case 'DO': case 'WHILE': return 'LOOP'
    case 'ENDDO': case 'ENDWHILE': return 'ENDLOOP'
    case 'LOOP': return 'LOOP'
    case 'ENDLOOP': return 'ENDLOOP'
    case 'SELECT': case 'UPDATE': case 'INSERT': case 'DELETE': case 'MODIFY':
      return 'SQL'
    case 'WRITE': case 'MESSAGE': return 'OUTPUT'
    case 'CALL': {
      if (tokens.length > 1) {
        const second = tokens[1].str.toUpperCase()
        if (second === 'FUNCTION') return 'CALL_FUNCTION'
        if (second === 'METHOD') return 'CALL_METHOD'
      }
      return 'CALL'
    }
    case 'FORM': return 'FORM'
    case 'ENDFORM': return 'ENDFORM'
    case 'PERFORM': return 'PERFORM'
    case 'REPORT': case 'PROGRAM': return 'REPORT'
    case 'FUNCTION-POOL': return 'FUNCTION_POOL'
    case 'FUNCTION': return 'FUNCTION'
    case 'ENDFUNCTION': return 'ENDFUNCTION'
    case 'TRY': return 'TRY'
    case 'CATCH': return 'CATCH'
    case 'ENDTRY': return 'ENDTRY'
    case 'RAISE': return 'RAISE'
    case 'RETURN': return 'RETURN'
    case 'APPEND': case 'READ': case 'SORT': case 'CLEAR': case 'FREE': case 'REFRESH':
      return 'ITAB'
    case 'MOVE': case 'COMPUTE': case 'ADD': case 'SUBTRACT': case 'MULTIPLY': case 'DIVIDE':
      return 'COMPUTE'
    case 'INCLUDE': return 'INCLUDE'
    case 'PUBLIC': case 'PRIVATE': case 'PROTECTED': return 'SECTION'
    case 'METHODS': case 'CLASS-METHODS': case 'EVENTS': case 'CLASS-EVENTS': case 'ALIASES':
      return 'DECLARATION'
    case 'INHERITING': case 'INTERFACES': case 'CREATE': return 'CLASS_OPTION'
    case 'CHECK': case 'ASSERT': return 'CHECK'
    case 'EXPORT': case 'IMPORT': return 'MEMORY'
    default: return 'UNKNOWN'
  }
}

/**
 * 把源码切成语句清单（handlers_context.go L86-158 handleParseABAP 主体）：
 * 整行注释独立成 COMMENT 语句；行内 " 引导的注释同；其余按 "." 断句，
 * 句内词元逐个标注。
 */
export function splitStatements(source: string): AbapStatement[] {
  const lines = source.split('\n')
  const statements: AbapStatement[] = []
  let currentTokens: AbapToken[] = []

  const flushCurrent = (type = 'UNKNOWN') => {
    if (currentTokens.length > 0) {
      statements.push({ type, tokens: currentTokens, first: currentTokens[0].str.toUpperCase() })
      currentTokens = []
    }
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const row = lineIdx + 1
    const trimmed = lines[lineIdx].trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('"')) {
      flushCurrent()
      statements.push({
        type: 'COMMENT',
        tokens: [{ str: trimmed, type: 'identifier', row }],
        first: trimmed.startsWith('*') ? '*' : '"'
      })
      continue
    }
    for (const w of tokenizeLine(lines[lineIdx])) {
      currentTokens.push({ str: w, type: tokenType(w), row })
      if (w === '.') {
        statements.push({
          type: classifyStatement(currentTokens),
          tokens: currentTokens,
          first: currentTokens[0].str.toUpperCase()
        })
        currentTokens = []
      }
    }
  }
  // 句尾无句号的残段：原样保留为 UNKNOWN
  flushCurrent()
  return statements
}

/** parseAbapSource 的返回（对齐 VSP handleParseABAP 的 ParseResult）。 */
export interface ParseAbapResult {
  /** 源码总行数。 */
  lines: number
  /** 语句总数。 */
  statements: number
  /** 逐条语句清单。 */
  stmts: AbapStatement[]
}

/** 纯客户端 ABAP 解析：词法 + 分句 + 分类（零 SAP 往返）。 */
export function parseAbap(source: string): ParseAbapResult {
  const stmts = splitStatements(source)
  return { lines: source.split('\n').length, statements: stmts.length, stmts }
}

/* ==========================================================================
 * 依赖分析输出（VSP handleAnalyzeDeps + analyzer.go 置信度模型的移植）
 * ========================================================================== */

/** 单个被分析依赖（对齐 VSP DepOut + 分析层语义）。 */
export interface AnalyzedDependency {
  name: string
  kind: DependencyKind
  /** 置信度 0.0-1.0：正则层单独证据记 0.8（analyzer.go L267-272 hasRegex 分支）。 */
  confidence: number
  /** 发现该依赖的分析层清单；本实现只有客户端 regex 层。 */
  foundBy: string[]
  /** 首次出现的行号。 */
  line?: number
  /** true 表示该名字的每一次出现都在字符串或注释里（疑似误报）。 */
  suspect?: boolean
}

/** analyzeDependencies 的返回（对齐 VSP AnalysisOut）。 */
export interface AnalyzeDependenciesResult {
  object: string
  lines: number
  totalDeps: number
  confirmedDeps: number
  falsePositives: number
  layers: string[]
  durationMs: number
  dependencies: AnalyzedDependency[]
}

/**
 * 判断一个字符位置是否处于字符串字面量或注释中（analyzer.go L565-611
 * quotedOrCommentedAt）：` ` 之外的双引号开启行注释；单引号字面量内 '' 是转义。
 */
function quotedOrCommentedAt(line: string, offset: number): boolean {
  let inLiteral = false
  for (let i = 0; i < offset && i < line.length; i++) {
    switch (line[i]) {
      case "'":
        if (inLiteral && i + 1 < line.length && line[i + 1] === "'") {
          i++ // 字面量内的转义引号
          continue
        }
        inLiteral = !inLiteral
        break
      case '"':
        if (!inLiteral) return true // 之后的整段都是行注释
        break
      case '`':
        inLiteral = !inLiteral
        break
    }
  }
  return inLiteral
}

/**
 * 该名字是否每一次出现都在字符串或注释里（analyzer.go L540-560）：
 * 完全没出现（名字来自索引而非文本）返回 false——不说源码没有的事。
 */
function occursOnlyInStringsOrComments(source: string, name: string): boolean {
  const n = name.trim().toUpperCase()
  if (!n) return false
  let found = false
  for (const rawLine of source.split('\n')) {
    const upper = rawLine.toUpperCase()
    const idx = upper.indexOf(n)
    if (idx < 0) continue
    found = true
    if (!quotedOrCommentedAt(rawLine, idx)) return false
  }
  return found
}

/**
 * 只读依赖分析（VSP handleAnalyzeDeps L163-235 + analyzer.go 置信度模型）。
 *
 * 本实现只带客户端 regex 层（VSP 的 parser/SCAN/CROSS 层分别依赖 Go 端
 * abaplint 移植与 SAP 端往返，未纳入本只读任务）；置信度按"有证据而不因
 * 单层沉默而降级"的现行模型记 0.8；函数模块按构造出现在引号里（CALL
 * FUNCTION 'X'），不做字符串误报检查（analyzer.go L168-174 的教训）。
 */
export function analyzeDependencies(source: string, objectName: string): AnalyzeDependenciesResult {
  const started = Date.now()
  const deps = extractDependencies(source)
  const dependencies: AnalyzedDependency[] = []
  let falsePositives = 0

  for (const d of deps) {
    const analyzed: AnalyzedDependency = {
      name: d.name,
      kind: d.kind,
      confidence: 0.8,
      foundBy: ['regex'],
      ...(d.line !== undefined ? { line: d.line } : {})
    }
    // 函数模块永远出现在引号里，不参与字符串误报判定
    if (d.kind !== 'FUNC' && occursOnlyInStringsOrComments(source, d.name)) {
      analyzed.suspect = true
      analyzed.confidence = 0.3
      falsePositives++
    }
    dependencies.push(analyzed)
  }
  // 置信度降序，其次名称升序（analyzer.go L282-290）
  dependencies.sort((a, b) => (a.confidence !== b.confidence ? b.confidence - a.confidence : (a.name < b.name ? -1 : 1)))

  return {
    object: objectName.toUpperCase(),
    lines: source.split('\n').length,
    totalDeps: dependencies.length,
    confirmedDeps: dependencies.filter(d => d.confidence >= 0.5).length,
    falsePositives,
    layers: ['regex'],
    durationMs: Date.now() - started,
    dependencies
  }
}

/* ==========================================================================
 * 副作用与 LUW 分析（VSP handlers_effects.go + pkg/graph/effects.go 的移植）
 * ========================================================================== */

/** 副作用清单（VSP graph/effects.go L11-55 EffectInfo 的等价结构）。 */
export interface EffectInfo {
  /** 自定义表读取清单（SELECT ... FROM，仅 Z/Y 开头的表）。 */
  readsDB: string[]
  /** 自定义表写入清单（INSERT/UPDATE/DELETE/MODIFY，仅 Z/Y 开头的表）。 */
  writesDB: string[]
  readsState: boolean
  writesState: boolean
  hasCommit: boolean
  hasRollback: boolean
  /** CALL FUNCTION ... IN UPDATE TASK：登记延迟更新。 */
  updateTask: boolean
  /** CALL FUNCTION ... IN BACKGROUND TASK。 */
  backgroundTask: boolean
  /** SET UPDATE TASK LOCAL。 */
  updateTaskLocal: boolean
  /** CALL FUNCTION ... STARTING NEW TASK。 */
  asyncRFC: boolean
  /** SUBMIT VIA JOB。 */
  backgroundJob: boolean
  /** SUBMIT AND RETURN。 */
  submitAndReturn: boolean
  /** DESTINATION 目标清单（同步 RFC）。 */
  syncRFC: string[]
  /** CL_HTTP_CLIENT / IF_HTTP_CLIENT 的使用。 */
  httpCall: boolean
  /** APC/WebSocket 推送。 */
  apcPush: boolean
  /** RAISE EXCEPTION。 */
  raisesExc: boolean
  /** MESSAGE TYPE E/A/X。 */
  raisesMessage: boolean
  /** LEAVE PROGRAM / LEAVE TO TRANSACTION。 */
  leavesContext: boolean
}

/**
 * LUW 分类（graph/effects.go L69-82 ClassifyLUW）：
 *   unsafe      —— 既 COMMIT 又登记延迟更新（两段提交各自落地，最危险）
 *   owner       —— 含 COMMIT/ROLLBACK（ owns 事务边界，上方调用方失去原子性）
 *   participant —— 登记延迟更新（写落在别人的 COMMIT 里，本处不可见）
 *   safe        —— 无事务影响。
 */
export function classifyLUW(e: EffectInfo): 'safe' | 'participant' | 'owner' | 'unsafe' {
  if (e.hasCommit && e.updateTask) return 'unsafe'
  if (e.hasCommit || e.hasRollback) return 'owner'
  if (e.updateTask || e.backgroundTask) return 'participant'
  return 'safe'
}

/** 无可观察副作用判定（graph/effects.go L58-67 IsPure）。 */
export function isPure(e: EffectInfo): boolean {
  return e.readsDB.length === 0 && e.writesDB.length === 0
    && !e.readsState && !e.writesState
    && !e.hasCommit && !e.hasRollback
    && !e.updateTask && !e.backgroundTask
    && !e.asyncRFC && !e.backgroundJob
    && e.syncRFC.length === 0 && !e.httpCall && !e.apcPush
}

/**
 * LUW 分类对应的调用方后果一句话（handlers_effects.go L36-49 luwConsequence）。
 * 标签不是严重度：owner 不比 participant 糟，它们是不同的规划约束。
 */
export function luwConsequence(luwClass: string): string {
  switch (luwClass) {
    case 'safe':
      return 'this unit neither commits nor registers deferred work, so it leaves its caller\'s transaction intact'
    case 'participant':
      return 'this unit registers work that runs when somebody else commits, so its writes land inside the caller\'s transaction and are invisible here'
    case 'owner':
      return 'this unit contains COMMIT WORK, so it ends its caller\'s transaction — every caller above it loses atomicity'
    case 'unsafe':
      return 'this unit both commits and registers deferred work, so part of what it queues may be committed by its own COMMIT and part by the caller\'s'
  }
  return 'the classification is not one this build knows about'
}

/** 检出效果的短语化（handlers_effects.go L51-75 effectList）。 */
function effectList(e: EffectInfo): string[] {
  const out: string[] = []
  const add = (cond: boolean, phrase: string) => { if (cond) out.push(phrase) }
  add(e.hasCommit, 'COMMIT WORK')
  add(e.hasRollback, 'ROLLBACK WORK')
  add(e.updateTask, 'registers work IN UPDATE TASK')
  add(e.backgroundTask, 'registers work IN BACKGROUND TASK')
  add(e.updateTaskLocal, 'SET UPDATE TASK LOCAL')
  add(e.asyncRFC, 'calls asynchronously (STARTING NEW TASK)')
  add(e.backgroundJob, 'submits a background job')
  add(e.submitAndReturn, 'SUBMIT AND RETURN')
  add(e.httpCall, 'opens an HTTP client')
  add(e.apcPush, 'pushes over APC/WebSocket')
  add(e.readsState, 'reads instance or class state')
  add(e.writesState, 'writes instance or class state')
  add(e.raisesExc, 'raises an exception')
  add(e.raisesMessage, 'issues MESSAGE type E/A/X')
  add(e.leavesContext, 'leaves the program or the transaction')
  return out
}

/** 自定义表名判定：Z/Y 首字符（graph/builder_parser.go L717-720 isCustomName）。 */
function isCustomName(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.length > 0 && (upper[0] === 'Z' || upper[0] === 'Y')
}

/** 词元序列匹配：从 toks 中找 keywords 连续出现（graph/effects.go hasTokenSequence）。 */
function hasTokenSequence(toks: string[], ...keywords: string[]): boolean {
  if (keywords.length === 0) return false
  outer: for (let i = 0; i <= toks.length - keywords.length; i++) {
    for (let j = 0; j < keywords.length; j++) {
      if (toks[i + j].toUpperCase() !== keywords[j]) continue outer
    }
    return true
  }
  return false
}

/** 某关键字之后的第一个词元（graph/effects.go tokenAfter）。 */
function tokenAfter(toks: string[], keyword: string): string {
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i].toUpperCase() === keyword) return toks[i + 1]
  }
  return ''
}

/**
 * INSERT/DELETE 语句的表名提取（graph/effects.go L249-269 extractDBTable）：
 * 关键字后若跟 INTO/FROM 则取再下一个词元；表名只统计 Z/Y 自定义表。
 */
function extractDBTable(toks: string[], keyword: string): string {
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i].toUpperCase() !== keyword) continue
    const next = toks[i + 1].toUpperCase()
    if (next === 'INTO' || next === 'FROM') {
      if (i + 2 < toks.length) {
        const tbl = toks[i + 2].toUpperCase()
        if (isCustomName(tbl)) return tbl
      }
    } else if (isCustomName(next)) {
      return next
    }
  }
  return ''
}

/**
 * 副作用提取（graph/effects.go L84-245 ExtractEffects 的语句级移植）。
 *
 * 与 VSP 的差异：VSP 用其 Go 版 abaplint 词法器 + 语句分类器驱动，本移植复用
 * splitStatements/tokenizeLine 的客户端分句；检出规则逐条一致（含"只统计
 * Z/Y 自定义表"的口径，标准表写入刻意不进清单）。
 * writesState 在 VSP 中声明但从未被检出赋值（effects.go 全文只写 readsState），
 * 本移植保持同语义以对齐行为。
 */
export function extractEffects(source: string): EffectInfo {
  const info: EffectInfo = {
    readsDB: [], writesDB: [], readsState: false, writesState: false,
    hasCommit: false, hasRollback: false, updateTask: false, backgroundTask: false,
    updateTaskLocal: false, asyncRFC: false, backgroundJob: false, submitAndReturn: false,
    syncRFC: [], httpCall: false, apcPush: false, raisesExc: false, raisesMessage: false,
    leavesContext: false
  }
  const seenReadDB = new Set<string>()
  const seenWriteDB = new Set<string>()
  const seenRFC = new Set<string>()

  for (const stmt of splitStatements(source)) {
    const toks = stmt.tokens.map(t => t.str)
    if (toks.length === 0) continue
    const first = toks[0].toUpperCase()
    const upperTokens = toks.map(t => t.toUpperCase())

    // SELECT ... FROM <table>：任一 FROM 后的词元（标准表被口径过滤）
    if (first === 'SELECT') {
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].toUpperCase() === 'FROM') {
          const tbl = toks[i + 1].toUpperCase()
          if (isCustomName(tbl) && !seenReadDB.has(tbl)) {
            info.readsDB.push(tbl)
            seenReadDB.add(tbl)
          }
        }
      }
    }
    // INSERT / DELETE：表名提取（含 INTO/FROM 两种句式）
    if (first === 'INSERT') {
      const tbl = extractDBTable(upperTokens, 'INSERT')
      if (tbl && !seenWriteDB.has(tbl)) {
        info.writesDB.push(tbl)
        seenWriteDB.add(tbl)
      }
    }
    if (first === 'DELETE') {
      const tbl = extractDBTable(upperTokens, 'DELETE')
      if (tbl && !seenWriteDB.has(tbl)) {
        info.writesDB.push(tbl)
        seenWriteDB.add(tbl)
      }
    }
    // UPDATE/MODIFY 不靠语句分类器，按首词元直取第二个词元（effects.go L130-147）
    if ((first === 'UPDATE' || first === 'MODIFY') && toks.length >= 2) {
      const tbl = toks[1].toUpperCase()
      if (isCustomName(tbl) && !seenWriteDB.has(tbl)) {
        info.writesDB.push(tbl)
        seenWriteDB.add(tbl)
      }
    }
    if (first === 'COMMIT') info.hasCommit = true
    if (first === 'ROLLBACK') info.hasRollback = true
    // SET UPDATE TASK LOCAL
    if (first === 'SET' && hasTokenSequence(upperTokens, 'SET', 'UPDATE', 'TASK', 'LOCAL')) {
      info.updateTaskLocal = true
    }
    // CALL FUNCTION 家族
    if (first === 'CALL' && toks.length > 1 && toks[1].toUpperCase() === 'FUNCTION') {
      const dest = tokenAfter(toks, 'DESTINATION')
      if (dest) {
        const cleaned = dest.replace(/^'|'$/g, '')
        if (cleaned && !seenRFC.has(cleaned)) {
          info.syncRFC.push(cleaned)
          seenRFC.add(cleaned)
        }
      }
      if (hasTokenSequence(upperTokens, 'IN', 'UPDATE', 'TASK')) info.updateTask = true
      if (hasTokenSequence(upperTokens, 'IN', 'BACKGROUND', 'TASK')) info.backgroundTask = true
      if (hasTokenSequence(upperTokens, 'STARTING', 'NEW', 'TASK')) info.asyncRFC = true
    }
    // SUBMIT 家族
    if (first === 'SUBMIT') {
      if (hasTokenSequence(upperTokens, 'VIA', 'JOB')) info.backgroundJob = true
      if (hasTokenSequence(upperTokens, 'AND', 'RETURN')) info.submitAndReturn = true
    }
    // RAISE EXCEPTION
    if (first === 'RAISE' && toks.length > 1 && toks[1].toUpperCase() === 'EXCEPTION') {
      info.raisesExc = true
    }
    // MESSAGE TYPE E/A/X
    if (first === 'MESSAGE') {
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].toUpperCase() === 'TYPE') {
          const msgType = toks[i + 1].toUpperCase().replace(/^'|'$/g, '')
          if (msgType === 'E' || msgType === 'A' || msgType === 'X') info.raisesMessage = true
          break
        }
      }
    }
    // LEAVE TO TRANSACTION / LEAVE PROGRAM
    if (first === 'LEAVE') {
      if (hasTokenSequence(upperTokens, 'LEAVE', 'TO', 'TRANSACTION')) info.leavesContext = true
      if (toks.length >= 2 && toks[1].toUpperCase() === 'PROGRAM') info.leavesContext = true
    }
    // 实例/类状态访问：me-> 与 self-> 前缀。
    // 与 VSP 的差异说明：VSP 逐词元做 strings.Contains(t, "->")（effects.go
    // L211-221），但其词法器把 me->counter 切成 me / -> / counter 三个词元，
    // 该分支实际永不命中（与 writesState 同属"声明了但检不出"的死分支）；
    // 本移植按词元序列 [me, ->, ...] 检出，使该分类真实生效。
    for (let i = 0; i < stmt.tokens.length - 1; i++) {
      const lower = stmt.tokens[i].str.toLowerCase()
      if ((lower === 'me' || lower === 'self') && stmt.tokens[i + 1].str === '->') {
        info.readsState = true
        break
      }
    }
    // HTTP 客户端
    for (const t of upperTokens) {
      if (t === 'CL_HTTP_CLIENT' || t === 'IF_HTTP_CLIENT') info.httpCall = true
    }
    // APC/WebSocket 推送
    for (const t of stmt.tokens) {
      const lower = t.str.toLowerCase()
      if (lower.includes('apc') && lower.includes('send')) info.apcPush = true
      if (t.str.toUpperCase() === 'I_APC_WSP_MESSAGE' || t.str.toUpperCase() === 'IF_APC_WSP_MESSAGE') {
        info.apcPush = true
      }
    }
  }
  return info
}

/** analyzeSourceEffects 的返回（对齐 VSP handlers_effects.go effectsAnswer）。 */
export interface AnalyzeEffectsResult {
  object?: string
  lines: number
  luw: string
  consequence: string
  pure: boolean
  readsTables?: string[]
  writesTables?: string[]
  rfcDestinations?: string[]
  effects?: string[]
  notes?: string[]
}

/**
 * 副作用与 LUW 归类（handlers_effects.go L77-113 analyseEffects）。
 * 边界说明随答案返回：这是本地分析，只读本源码，被调用者内部的提交不在此处。
 */
export function analyzeEffects(object: string, source: string): AnalyzeEffectsResult {
  const e = extractEffects(source)
  const luw = classifyLUW(e)
  const answer: AnalyzeEffectsResult = {
    object,
    lines: source.split('\n').length,
    luw,
    consequence: luwConsequence(luw),
    pure: isPure(e),
    ...(e.readsDB.length > 0 ? { readsTables: e.readsDB } : {}),
    ...(e.writesDB.length > 0 ? { writesTables: e.writesDB } : {}),
    ...(e.syncRFC.length > 0 ? { rfcDestinations: e.syncRFC } : {}),
    effects: effectList(e)
  }
  const notes: string[] = [
    'this is local analysis: it reads this source only, so an effect inside something it calls is not counted here'
  ]
  if (answer.pure) {
    notes.push('pure here means no effect was detected in this source, not that the unit is pure transitively')
  }
  if (e.writesDB.length > 0 && luw === 'participant') {
    notes.push('the writes listed are issued directly; the deferred ones are not visible in this source at all')
  }
  answer.notes = notes
  return answer
}

/* ==========================================================================
 * 压缩主流程（VSP compressor.go Compress 的移植，串行取源）
 * ========================================================================== */

/** 取源通道：给定种类与名字取回完整源码（对齐 VSP SourceProvider）。 */
export type SourceFetcher = (kind: SourceKind, name: string) => Promise<string>

/** maxDeps 默认值（VSP NewCompressor L14-18）。 */
export const DEFAULT_MAX_DEPS = 20
/** maxDeps 上限：20 个契约已是一段很长的上下文，防御性收敛。 */
export const MAX_DEPS_CAP = 50
/** depth 上下界（VSP WithDepth L24-31：1=直接依赖，最大 3）。 */
export const MIN_DEPTH = 1
export const MAX_DEPTH = 3

/** compress 的输入。 */
export interface CompressInput {
  /** 已有的顶层源码（可选：给了就不再按名字取顶层源码）。 */
  source?: string
  /** 顶层对象名（必填，用于 prologue 标题与自引用过滤）。 */
  objectName: string
  /** 顶层对象类型（必填，取源与标注用）。 */
  objectType: SourceKind
  /** 契约预算，默认 20，上限 50。 */
  maxDeps?: number
  /** 展开深度 1..3，默认 1。 */
  depth?: number
}

/**
 * 压缩主流程（VSP compressor.go L41-148 Compress）：
 * 逐层提取依赖 → 排序 → 按预算批量取契约（失败不占槽位）→ 深层用上一层的
 * 完整源码继续展开 → 拼装 prologue。
 */
export async function compress(
  fetchSource: SourceFetcher,
  input: CompressInput
): Promise<{ dependencies: Dependency[]; contracts: Contract[]; prologue: string; stats: ContextStats }> {
  const objectName = input.objectName.trim().toUpperCase()
  const maxDeps = normalizeMaxDeps(input.maxDeps)
  const maxDepth = normalizeDepth(input.depth)

  let topLevelSource = input.source ?? ''
  if (!topLevelSource) {
    topLevelSource = await fetchSource(input.objectType, objectName)
  }

  const seen = new Set<string>([objectName])
  const allDeps: Dependency[] = []
  const allContracts: Contract[] = []

  let pendingSources = [topLevelSource]
  let pendingNames = [objectName]

  for (let level = 1; level <= maxDepth; level++) {
    const levelDeps: Dependency[] = []
    for (let i = 0; i < pendingSources.length; i++) {
      const src = pendingSources[i]
      let deps = extractDependencies(src)
      // 自引用过滤（compressor.go filterSelf L188-196）
      deps = deps.filter(d => d.name !== pendingNames[i].toUpperCase())
      // 归集本源码在每个依赖上调用的方法，供契约收窄（compressor.go L69-73）
      const called = methodsCalledOn(src)
      for (const d of deps) {
        const methods = called.get(d.name)
        if (methods && methods.length > 0) d.methods = methods
        if (!seen.has(d.name)) {
          levelDeps.push(d)
          seen.add(d.name)
        }
      }
    }

    if (levelDeps.length === 0) break

    // 按"读者需要什么"排序（compressor.go L75-83）
    const ranked = rankCandidates(pendingSources.join('\n'), levelDeps)
    const ordered = ranked.map(r => r.dependency)

    // 预算按到手契约计算：按排名成批尝试（批大小 = 剩余槽位×2），失败的
    // 名字消耗一次取数而不是槽位（compressor.go L96-124 注释原文：A failure
    // costs a fetch and not a slot）
    const remaining = maxDeps - allDeps.length
    if (remaining <= 0) break
    const levelKept: Dependency[] = []
    const levelContracts: Contract[] = []
    const levelSources: string[] = []
    // 取不到的依赖：进全局答案成为可见缺口，但不占预算、不再向下展开
    // （对齐 VSP：失败契约只进 allDeps/allContracts，不进 levelKept）
    const levelGaps: Array<{ dep: Dependency; contract: Contract }> = []
    let offset = 0
    while (offset < ordered.length && levelKept.length < remaining) {
      let batch = ordered.slice(offset)
      const want = (remaining - levelKept.length) * 2
      if (want > 0 && batch.length > want) batch = batch.slice(0, want)
      // 串行取源（VSP 用 5 路并发；本项目保持 SAP 调用串行的产品红线）。
      // 串行下逐个取数即可达成同一预算语义：槽位满即停，不浪费取数。
      for (let i = 0; i < batch.length; i++) {
        const d = batch[i]
        if (levelKept.length >= remaining) break
        try {
          const fullSource = await fetchSource(d.kind, d.name)
          const compressed = extractContract(fullSource, d.kind)
          const methods = d.methods ?? []
          const [narrowed, total, shown] = narrowContract(compressed, methods)
          levelKept.push(d)
          levelContracts.push({
            name: d.name,
            kind: d.kind,
            source: narrowed,
            methodsTotal: total,
            methodsShown: shown
          })
          levelSources.push(fullSource)
        } catch (error) {
          // 解析失败的依赖保留在答案里成为可见缺口（compressor.go L112-121）
          levelGaps.push({
            dep: d,
            contract: {
              name: d.name,
              kind: d.kind,
              source: '',
              methodsTotal: 0,
              methodsShown: 0,
              error: error instanceof Error ? error.message : String(error)
            }
          })
        }
      }
      offset += batch.length
    }

    allDeps.push(...levelKept, ...levelGaps.map(g => g.dep))
    allContracts.push(...levelContracts, ...levelGaps.map(g => g.contract))

    // 准备下一层：用本轮取回的完整源码继续提取依赖（compressor.go L139-146）
    if (level < maxDepth) {
      pendingSources = []
      pendingNames = []
      for (let i = 0; i < levelSources.length; i++) {
        if (levelSources[i]) {
          pendingSources.push(levelSources[i])
          pendingNames.push(levelKept[i].name)
        }
      }
    }
  }

  const prologue = formatPrologue(objectName, allContracts)
  const stats: ContextStats = {
    depsFound: allContracts.length,
    depsResolved: allContracts.filter(c => !c.error && c.source).length,
    depsFailed: allContracts.filter(c => c.error || !c.source).length,
    totalLines: prologue.split('\n').length
  }
  const unresolved = allContracts.filter(c => c.error || !c.source).map(c => c.name)
  return { dependencies: allDeps, contracts: allContracts, prologue, stats }
}

/** maxDeps 边界收敛：默认 20，钳到 [1, 50]。 */
function normalizeMaxDeps(value?: number): number {
  const requested = Number(value ?? DEFAULT_MAX_DEPS)
  const finite = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_DEPS
  return Math.min(finite, MAX_DEPS_CAP)
}

/** depth 边界收敛：钳到 [1, 3]（VSP WithDepth 语义）。 */
function normalizeDepth(value?: number): number {
  const requested = Number(value ?? MIN_DEPTH)
  const finite = Number.isFinite(requested) ? Math.floor(requested) : MIN_DEPTH
  return Math.min(Math.max(finite, MIN_DEPTH), MAX_DEPTH)
}

/**
 * prologue 拼装（VSP compressor.go L203-290 formatPrologue）：
 * 标题行 + 未解析名单（命名而非丢弃）+ 每个契约一段（头部注明种类与方法数，
 * 收窄时注明"调用此处 N 个"）。
 */
export function formatPrologue(objectName: string, contracts: readonly Contract[]): string {
  const resolved: Contract[] = []
  const unresolvedNames: string[] = []
  for (const c of contracts) {
    if (!c.error && c.source) {
      resolved.push(c)
    } else {
      unresolvedNames.push(c.name)
    }
  }
  if (resolved.length === 0) return ''

  const sb: string[] = []
  sb.push(`* === Dependency context for ${objectName} (${resolved.length} deps) ===`)
  if (unresolvedNames.length > 0) {
    unresolvedNames.sort()
    sb.push(`* ${unresolvedNames.length} referenced without a contract here (types, structures, or unreadable): ${unresolvedNames.join(', ')}`)
  }
  for (const c of resolved) {
    const kindLabel = c.kind === 'INTF' ? 'interface' : c.kind === 'FUNC' ? 'function module' : 'class'
    // 头部携带收窄丢弃了多少（一个数字，不是 47 个名字的清单——完整公开面
    // 一次显式请求就能拿到，往每份上下文里塞它是压缩的反面）
    let methodCount = c.methodsTotal
    if (methodCount === 0) methodCount = countOccurrences(c.source.toUpperCase(), 'METHODS ')
    let info = kindLabel
    if (methodCount > 0) {
      info = `${kindLabel}, ${methodCount} methods`
      if (c.methodsShown > 0 && c.methodsShown < c.methodsTotal) {
        info += `; ${c.methodsShown} called here`
      }
    }
    sb.push('')
    sb.push(`* --- ${c.name} (${info}) ---`)
    sb.push(c.source)
    sb.push('')
  }
  return sb.join('\n')
}

/* ==========================================================================
 * 客户端绑定（窄接口注入，风格对齐 CrossReferenceApi 的 bind 模式）
 * ========================================================================== */

/**
 * 项目 ADT 客户端的最小结构视图（duck typing，不 import AdtClient，避免制造
 * 接线耦合）：searchObject/objectStructure/getObjectSource 三步完成只读取源。
 */
export interface AdtContextSourceCapability {
  searchObject(query: string, objType?: string, max?: number): Promise<Array<Record<string, any>>>
  objectStructure(objectUrl: string, version?: string): Promise<any>
  getObjectSource(objectSourceUrl: string, options?: unknown): Promise<string>
}

/** 处理器注入用的窄客户端接口。 */
export interface ContextAnalysisClient {
  getDependencyContext(input: GetDependencyContextInput): Promise<GetDependencyContextResult>
  analyzeDependencies(input: AnalyzeDependenciesInput): Promise<AnalyzeDependenciesResult>
  parseAbapSource(input: ParseAbapInput): Promise<ParseAbapResult>
  analyzeSourceEffects(input: AnalyzeEffectsInput): Promise<AnalyzeEffectsResult>
}

/** getDependencyContext 输入（对齐 VSP handleGetContext 参数面）。 */
export interface GetDependencyContextInput {
  objectType: SourceKind
  objectName: string
  maxDeps?: number
  depth?: number
}

/** analyzeDependencies / parseAbapSource / analyzeSourceEffects 共用输入形态：源码或对象二选一。 */
export interface AnalyzeDependenciesInput {
  source?: string
  objectType?: SourceKind
  objectName?: string
}
export type ParseAbapInput = AnalyzeDependenciesInput
export type AnalyzeEffectsInput = AnalyzeDependenciesInput

/**
 * 从 quick search 结果里挑出"名字与种类都精确匹配"的唯一对象（匹配口径对齐
 * safe/AbapObjectResolver.ts L153-176 matchesObject 的只读子集，新增 INTF：
 * adtcore:type 以 INTF/ 开头或 URI 含 /OO/INTERFACES/）。
 */
function pickExactObject(
  results: Array<Record<string, any>>,
  kind: SourceKind,
  name: string
): Record<string, any> | undefined {
  const matches = results.filter(result => {
    const uri = safeDecode(String(result['adtcore:uri'] ?? '')).toUpperCase()
    const resultName = String(result['adtcore:name'] ?? '').toUpperCase()
    const uriName = uriObjectNameFromUri(uri)
    const exactName = resultName === name || uriName === name
    if (!exactName) return false
    const adtType = String(result['adtcore:type'] ?? '').toUpperCase()
    switch (kind) {
      case 'CLAS': return adtType.startsWith('CLAS/') || uri.includes('/OO/CLASSES/')
      case 'INTF': return adtType.startsWith('INTF/') || uri.includes('/OO/INTERFACES/')
      case 'PROG': return adtType.startsWith('PROG/P') || uri.includes('/PROGRAMS/PROGRAMS/')
      case 'FUNC': return uri.includes('/FUNCTIONS/GROUPS/') && uri.includes('/FMODULES/')
    }
  })
  return matches.length === 1 ? matches[0] : undefined
}

/** 从 URI 末段推对象名（AbapObjectResolver uriObjectName 的只读子集）。 */
function uriObjectNameFromUri(uri: string): string | undefined {
  const markers = ['/OO/CLASSES/', '/OO/INTERFACES/', '/PROGRAMS/PROGRAMS/', '/FMODULES/', '/PROGRAMS/INCLUDES/']
  for (const marker of markers) {
    const idx = uri.indexOf(marker)
    if (idx >= 0) {
      const rest = uri.slice(idx + marker.length)
      const end = rest.search(/[?(]/)
      return (end >= 0 ? rest.slice(0, end) : rest).toUpperCase()
    }
  }
  return undefined
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把 ADT 返回的源 URI 规范化为绝对路径（口径对齐 read/AbapMemberSourceReader.ts
 * L220-229 的 resolveSourceUrl）：ADT 的 include 源链接常是相对对象的逻辑路径
 * （如 source/main），必须拼到 objectUrl 之后；绝对路径（/sap/bc/adt/ 开头）
 * 原样返回。相对段携带 ..、://、协议或查询串时一律拒绝。
 */
function absolutizeSourceUrl(value: string, objectUrl: string): string {
  const normalized = String(value || '').trim()
  if (normalized.startsWith('/sap/bc/adt/')) return normalized
  const relative = normalized.replace(/^\.\//, '')
  if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('://') || /[?#]/.test(relative)) {
    throw new Error('ADT returned an invalid source URI')
  }
  // ADT 源链接相对对象资源按逻辑目录拼接
  return `${objectUrl.replace(/\/+$/, '')}/${relative}`
}

/**
 * 把 ADT 客户端绑定成取源通道（对齐 VSP adtSourceAdapter，handlers_context.go
 * L31-36）：quick search 精确匹配 → objectStructure 取源 URI → getObjectSource。
 * 每个依赖三次只读往返，全程串行；任何一步失败即抛错，由调用方（compress）
 * 归档为该依赖的 unresolved 缺口。
 */
export function createSourceFetcher(client: AdtContextSourceCapability): SourceFetcher {
  return async (kind, name) => {
    const upper = name.trim().toUpperCase()
    const results = await client.searchObject(upper, undefined, 50)
    const exact = pickExactObject(results ?? [], kind, upper)
    if (!exact) {
      throw new Error(`no unique ${kind} object named ${upper} was found by quick search`)
    }
    const objectUri = String(exact['adtcore:uri'] ?? '')
    if (!objectUri) {
      throw new Error(`quick search returned no URI for ${kind} ${upper}`)
    }
    const structure = await client.objectStructure(objectUri, 'active')
    // 源 URI 解析口径与 safe/AbapObjectResolver.resolveSourceUrl 一致：类优先取
    // main include，其余对象取 metaData 的 abapsource:sourceUri；include 的
    // 源链接常是相对 URI（如 source/main），先绝对化再读取
    const classIncludes: Array<Record<string, any>> = structure && 'includes' in structure ? structure.includes : []
    const mainInclude = classIncludes.find(include => include['class:includeType'] === 'main')
    const rawSourceUrl = mainInclude?.['abapsource:sourceUri'] || structure?.metaData?.['abapsource:sourceUri']
    if (!rawSourceUrl) {
      throw new Error(`ADT metadata provided no source URI for ${kind} ${upper}`)
    }
    const sourceUrl = absolutizeSourceUrl(rawSourceUrl, objectUri)
    return await client.getObjectSource(sourceUrl)
  }
}

/**
 * 把取源通道绑定成处理器可注入的四能力客户端（本任务的对外入口）。
 */
export function createContextAnalysisClient(client: AdtContextSourceCapability): ContextAnalysisClient {
  const fetchSource = createSourceFetcher(client)
  return {
    async getDependencyContext(input) {
      const objectName = input.objectName.trim().toUpperCase()
      const { contracts, prologue, stats } = await compress(fetchSource, {
        objectName,
        objectType: input.objectType,
        maxDeps: input.maxDeps,
        depth: input.depth
      })
      // 未解析名单直接从契约清单导出（error 或空契约源），与 prologue 报告行一致
      const unresolved = contracts.filter(c => c.error || !c.source).map(c => c.name)
      return {
        objectName,
        objectType: input.objectType,
        prologue,
        stats,
        unresolved
      }
    },
    async analyzeDependencies(input) {
      const { source, name } = await resolveAnalysisInput(fetchSource, input)
      return analyzeDependencies(source, name)
    },
    async parseAbapSource(input) {
      const { source } = await resolveAnalysisInput(fetchSource, input)
      return parseAbap(source)
    },
    async analyzeSourceEffects(input) {
      const { source, name } = await resolveAnalysisInput(fetchSource, input)
      return analyzeEffects(name, source)
    }
  }
}

/**
 * 三个纯分析工具共用：源码优先；没给源码就按 objectType+objectName 取。
 * 返回 name 供结果标注（VSP handleParseABAP/handleAnalyzeDeps 的取源分支）。
 */
async function resolveAnalysisInput(
  fetchSource: SourceFetcher,
  input: AnalyzeDependenciesInput
): Promise<{ source: string; name: string }> {
  if (input.source && input.source.trim() !== '') {
    return {
      source: input.source,
      name: (input.objectName ?? 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN'
    }
  }
  if (!input.objectType || !input.objectName) {
    throw new Error('either source or objectType+objectName is required')
  }
  const name = input.objectName.trim().toUpperCase()
  const source = await fetchSource(input.objectType, name)
  return { source, name }
}
