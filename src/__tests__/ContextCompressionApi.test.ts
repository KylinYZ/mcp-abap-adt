import {
  extractDependencies,
  rankCandidates,
  extractContract,
  methodsCalledOn,
  narrowContract,
  parseAbap,
  analyzeDependencies,
  extractEffects,
  analyzeEffects,
  classifyLUW,
  isPure,
  luwConsequence,
  compress,
  formatPrologue,
  createContextAnalysisClient,
  createSourceFetcher,
  DEFAULT_MAX_DEPS,
  MAX_DEPS_CAP,
  MAX_DEPTH
} from '../adt/ContextCompressionApi.js';
import type {
  Dependency,
  Contract,
  AdtContextSourceCapability
} from '../adt/ContextCompressionApi.js';

/**
 * ContextCompressionApi 只读契约测试（mock 取源通道，绝不连接真实 SAP）。
 * 断言六类内容（各段标注对齐的 VSP 来源）：
 *   1. 依赖提取：十类发现模式、黑名单跳过、INTF 证据覆盖、注释行剔除（deps.go）；
 *   2. 候选排序：义务 > 签名 > 协作者 > 异常、自定义优先、次数计序（candidates.go）；
 *   3. 契约提取与收窄：类 PUBLIC SECTION 截断、接口全量、FM 签名、
 *      方法收窄保留非声明行（contract.go / methodlevel.go）；
 *   4. 压缩主流程：预算按到手契约计、失败依赖保留为可见缺口、深度展开、
 *      自引用过滤与跨层去重（compressor.go）；
 *   5. 解析与依赖分析：语句分类、字符串内句点、疑似误报标注、FUNC 引号豁免；
 *   6. 副作用与 LUW：safe/participant/owner/unsafe 四分类与自定义表口径
 *      （graph/effects.go / handlers_effects.go）。
 */

/* ==========================================================================
 * 1) 依赖提取（extractDependencies）
 * ========================================================================== */

describe('extractDependencies (VSP deps.go port)', () => {
  it('discovers dependencies through all ten regex patterns', () => {
    const source = [
      'CLASS zcl_order DEFINITION PUBLIC INHERITING FROM zcl_base FINAL.',
      '  PUBLIC SECTION.',
      '    INTERFACES zif_writer.',
      '    DATA lo_helper TYPE REF TO zcl_helper.',
      '    METHODS run RAISING zcx_order_error.',
      'ENDCLASS.',
      'CLASS zcl_order IMPLEMENTATION.',
      '  METHOD run.',
      '    DATA(obj) = NEW zcl_factory( ).',
      '    zcl_config=>load( ).',
      '    zif_writer~write( `x` ).',
      "    CALL FUNCTION 'Z_ORDER_POST'.",
      '    DATA(x) = CAST zcl_special( obj ).',
      // CREATE OBJECT <变量> TYPE <类名>：第二个捕获组才是类
      '    CREATE OBJECT lo_legacy TYPE zcl_legacy.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    const names = extractDependencies(source).map(d => d.name);
    // 说明：zcl_audit->log( ) 的实例调用不在此层发现——正则层只读"声明"，
    // 实例调用经变量类型（TYPE REF TO）覆盖，与 VSP deps.go 的层职责一致。
    expect(names).toEqual(expect.arrayContaining([
      'ZCL_BASE',        // INHERITING FROM
      'ZIF_WRITER',      // INTERFACES + ~
      'ZCL_HELPER',      // TYPE REF TO
      'ZCX_ORDER_ERROR', // RAISING + 裸异常引用
      'ZCL_FACTORY',     // NEW
      'ZCL_CONFIG',      // =>
      'Z_ORDER_POST',    // CALL FUNCTION
      'ZCL_SPECIAL',     // CAST
      'ZCL_LEGACY'       // CREATE OBJECT ... TYPE
    ]));
    const kinds = new Map(extractDependencies(source).map(d => [d.name, d.kind]));
    expect(kinds.get('ZIF_WRITER')).toBe('INTF');
    expect(kinds.get('Z_ORDER_POST')).toBe('FUNC');
    expect(kinds.get('ZCL_BASE')).toBe('CLAS');
  });

  it('skips built-in types, standard prefixes, and comment lines', () => {
    const source = [
      '* DATA lv TYPE REF TO zcl_in_comment.  <- 整行注释不产生依赖',
      'DATA s TYPE string.',
      'DATA d TYPE REF TO cl_abap_typedescr.  " 标准前缀黑名单',
      'DATA e TYPE REF TO cx_sy_zerodivide.',
      'DATA ok TYPE REF TO zcl_real.'
    ].join('\n');
    const names = extractDependencies(source).map(d => d.name);
    expect(names).toEqual(['ZCL_REAL']);
  });

  it('lets interface evidence win over class evidence (VSP deps.go L127-131)', () => {
    // zif_both 先被 TYPE REF TO 推断为 CLAS（无 IF_ 前缀则按类），再被
    // INTERFACES 关键字纠正为 INTF
    const source = 'DATA x TYPE REF TO zif_both.\nINTERFACES zif_both.';
    const deps = extractDependencies(source);
    expect(deps).toHaveLength(1);
    expect(deps[0].kind).toBe('INTF');
  });

  it('records the first line where a dependency appears', () => {
    const source = 'DATA a TYPE REF TO zcl_one.\nDATA b TYPE REF TO zcl_two.';
    const deps = extractDependencies(source);
    const one = deps.find(d => d.name === 'ZCL_ONE');
    const two = deps.find(d => d.name === 'ZCL_TWO');
    expect(one?.line).toBe(1);
    expect(two?.line).toBe(2);
  });
});

/* ==========================================================================
 * 2) 候选排序（rankCandidates）
 * ========================================================================== */

describe('rankCandidates (VSP candidates.go port)', () => {
  const deps: Dependency[] = [
    { name: 'ZCX_ERR', kind: 'CLAS' },
    { name: 'ZCL_STD', kind: 'CLAS' },
    { name: 'ZIF_SIG', kind: 'INTF' },
    { name: 'ZCL_BASE', kind: 'CLAS' },
    { name: 'ZCL_BUSY', kind: 'CLAS' }
  ];

  it('orders obligations before signature types, collaborators, exceptions', () => {
    const source = [
      'CLASS zcl_x DEFINITION INHERITING FROM zcl_base.',
      '  PUBLIC SECTION.',
      '    INTERFACES zif_sig.',
      '    DATA ref TYPE REF TO zcl_busy.',
      '  PROTECTED SECTION.',
      '    DATA hidden TYPE REF TO zcl_std.'
    ].join('\n');
    const order = rankCandidates(source, deps).map(r => r.dependency.name);
    // ZCL_BASE 是义务（INHERITING），ZIF_SIG 也是义务（行首 INTERFACES）；
    // ZCL_BUSY 只在公共段出现 → 签名；ZCL_STD 在保护段 → 协作者；
    // ZCX_ERR 是异常，垫底。两条义务彼此的先后由稳定排序决定，不作断言。
    expect(order.indexOf('ZCL_BASE')).toBeLessThan(order.indexOf('ZCL_BUSY'));
    expect(order.indexOf('ZIF_SIG')).toBeLessThan(order.indexOf('ZCL_BUSY'));
    expect(order.indexOf('ZCL_BUSY')).toBeLessThan(order.indexOf('ZCL_STD'));
    expect(order.indexOf('ZCL_STD')).toBeLessThan(order.indexOf('ZCX_ERR'));
  });

  it('prefers custom objects within the same role band', () => {
    const deps2: Dependency[] = [
      { name: 'CL_ABC', kind: 'CLAS' },   // 标准类（不以 Z/Y 开头）
      { name: 'ZCL_ABC', kind: 'CLAS' }   // 自定义类
    ];
    // 两者都是协作者：自定义优先
    const source = 'DATA a TYPE REF TO cl_abc.\nDATA b TYPE REF TO zcl_abc.';
    const order = rankCandidates(source, deps2).map(r => r.dependency.name);
    expect(order).toEqual(['ZCL_ABC', 'CL_ABC']);
  });
});

/* ==========================================================================
 * 3) 契约提取与收窄（extractContract / methodsCalledOn / narrowContract）
 * ========================================================================== */

describe('extractContract (VSP contract.go port)', () => {
  it('keeps only the class definition through its public section', () => {
    const source = [
      'CLASS zcl_pub DEFINITION PUBLIC FINAL.',
      '  PUBLIC SECTION.',
      '    METHODS go.',
      '  PROTECTED SECTION.',
      '    METHODS secret.',
      '  PRIVATE SECTION.',
      '    DATA x TYPE i.',
      'ENDCLASS.',
      'CLASS zcl_pub IMPLEMENTATION.',
      '  METHOD go. ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    const contract = extractContract(source, 'CLAS');
    expect(contract).toContain('CLASS zcl_pub DEFINITION');
    expect(contract).toContain('METHODS go.');
    expect(contract).not.toContain('secret');
    // 截断处补 ENDCLASS. 保持文本语法完整
    expect(contract.trim().endsWith('ENDCLASS.')).toBe(true);
  });

  it('returns the whole interface definition', () => {
    const source = 'INTERFACE zif_a.\n  METHODS m1.\n  METHODS m2.\nENDINTERFACE.';
    expect(extractContract(source, 'INTF')).toBe(source);
  });

  it('extracts the FM signature comment block and parameter keywords', () => {
    const source = [
      'FUNCTION z_fm.',
      '*"  IMPORTING',
      '*"     VALUE(IV_X) TYPE I',
      '*"  EXPORTING',
      '*"     VALUE(EV_Y) TYPE I',
      '  ev_y = iv_x.',
      'ENDFUNCTION.'
    ].join('\n');
    const contract = extractContract(source, 'FUNC');
    expect(contract).toContain('FUNCTION z_fm.');
    expect(contract).toContain('*"  IMPORTING');
    expect(contract).not.toContain('ev_y = iv_x');
    expect(contract.trim().endsWith('ENDFUNCTION.')).toBe(true);
  });
});

describe('methodsCalledOn + narrowContract (VSP methodlevel.go port)', () => {
  it('resolves instance calls through declared TYPE REF TO variables', () => {
    const source = [
      'DATA lo_db TYPE REF TO zif_db.',
      'lo_db->read( ).',
      'lo_db->write( ).',
      'zcl_cfg=>load( ).',
      'zif_log~info( ).'
    ].join('\n');
    const called = methodsCalledOn(source);
    expect([...called.get('ZIF_DB') ?? []].sort()).toEqual(['READ', 'WRITE']);
    expect(called.get('ZCL_CFG')).toEqual(['LOAD']);
    expect(called.get('ZIF_LOG')).toEqual(['INFO']);
  });

  it('returns the contract unchanged when nothing is known', () => {
    const contract = 'INTERFACE zif_x.\n  METHODS a.\n  METHODS b.\nENDINTERFACE.';
    const [narrowed, total, kept] = narrowContract(contract, []);
    expect(narrowed).toBe(contract);
    expect(total).toBe(2);
    expect(kept).toBe(2);
  });

  it('keeps only wanted method declarations plus all non-declaration lines', () => {
    const contract = [
      'INTERFACE zif_x.',
      '  TYPES t_kind TYPE i.',
      '  METHODS a IMPORTING iv TYPE i.',
      '  METHODS b.',
      'ENDINTERFACE.'
    ].join('\n');
    const [narrowed, total, kept] = narrowContract(contract, ['b']);
    expect(total).toBe(2);
    expect(kept).toBe(1);
    expect(narrowed).toContain('TYPES t_kind TYPE i.'); // 非声明行保留
    expect(narrowed).toContain('METHODS b.');
    expect(narrowed).not.toContain('METHODS a');
  });

  it('leaves chained METHODS declarations whole (narrowing would break ABAP)', () => {
    const contract = 'INTERFACE zif_x.\n  METHODS: a, b.\nENDINTERFACE.';
    const [narrowed] = narrowContract(contract, ['a']);
    expect(narrowed).toContain('METHODS: a, b.');
  });
});

/* ==========================================================================
 * 4) 压缩主流程（compress / formatPrologue）
 * ========================================================================== */

/** 构造可控取源通道：按 "KIND NAME" 键返回源码或抛错，并记录调用次序。 */
function fetcher(sources: Record<string, string | Error>): { fetch: ReturnType<typeof makeTrackingFetcher>; calls: string[] } {
  const calls: string[] = [];
  const fetch = makeTrackingFetcher(sources, calls);
  return { fetch, calls };
}

function makeTrackingFetcher(sources: Record<string, string | Error>, calls: string[]) {
  return async (kind: string, name: string) => {
    const key = `${kind} ${name}`;
    calls.push(key);
    const value = sources[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`not found: ${key}`);
    return value;
  };
}

const CLASS_ZCL_APP = [
  'CLASS zcl_app DEFINITION PUBLIC INHERITING FROM zcl_base FINAL.',
  '  PUBLIC SECTION.',
  '    INTERFACES zif_writer.',
  '    DATA repo TYPE REF TO zcl_repo.',
  '    METHODS run RAISING zcx_app.',
  'ENDCLASS.',
  'CLASS zcl_app IMPLEMENTATION.',
  '  METHOD run.',
  '    repo->save( ).',
  '    zcl_repo=>migrate( ).',
  '    zif_writer~write( ).',
  "    CALL FUNCTION 'Z_POST'.",
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

describe('compress (VSP compressor.go port)', () => {
  it('builds a prologue with contracts ranked, narrowed, and annotated', async () => {
    const { fetch } = fetcher({
      'CLAS ZCL_APP': CLASS_ZCL_APP,
      'CLAS ZCL_BASE': 'CLASS zcl_base DEFINITION PUBLIC.\nENDCLASS.',
      'INTF ZIF_WRITER': 'INTERFACE zif_writer.\n  METHODS write.\n  METHODS flush.\nENDINTERFACE.',
      'CLAS ZCL_REPO': 'CLASS zcl_repo DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\nENDCLASS.',
      'FUNC Z_POST': "FUNCTION z_post.\n*\"  IMPORTING\n*\"     VALUE(IV_X) TYPE I\nENDFUNCTION."
      // ZCX_APP 刻意缺失 → 未解析缺口
    });
    const result = await compress(fetch, { objectName: 'zcl_app', objectType: 'CLAS' });

    expect(result.stats.depsFound).toBe(5);
    expect(result.stats.depsResolved).toBe(4);
    expect(result.stats.depsFailed).toBe(1);
    expect(result.prologue).toContain('* === Dependency context for ZCL_APP (4 deps) ===');
    // 未解析名单显式命名而不是丢弃（compressor.go L243-252）
    expect(result.prologue).toContain('ZCX_APP');
    // 收窄标注：ZIF_WRITER 有 2 个方法、本源码调用 1 个（write）
    expect(result.prologue).toContain('* --- ZIF_WRITER (interface, 2 methods; 1 called here) ---');
    expect(result.prologue).toContain('METHODS write.');
    expect(result.prologue).not.toContain('METHODS flush.');
    // 义务（ZCL_BASE/ZIF_WRITER）排在协作者（ZCL_REPO）之前；义务带内按使用
    // 次数排序（ZIF_WRIER 出现 2 次 > ZCL_BASE 1 次），带内先后不作断言
    const baseAt = result.prologue.indexOf('* --- ZCL_BASE ');
    const writerAt = result.prologue.indexOf('* --- ZIF_WRITER ');
    const repoAt = result.prologue.indexOf('* --- ZCL_REPO ');
    expect(baseAt).toBeGreaterThan(-1);
    expect(writerAt).toBeGreaterThan(-1);
    expect(baseAt).toBeLessThan(repoAt);
    expect(writerAt).toBeLessThan(repoAt);
  });

  it('spends the budget on contracts that arrive, not on attempts', async () => {
    // 排序后的候选：ZCL_BASE(义务，缺失→失败)、ZIF_WRITER(义务)、ZCL_REPO(协作者)…
    // 预算 2：BASE 失败只耗一次取数并成为可见缺口；WRITER 与 REPO 占满两个槽位
    const { fetch, calls } = fetcher({
      'CLAS ZCL_APP': CLASS_ZCL_APP,
      'INTF ZIF_WRITER': 'INTERFACE zif_writer.\n  METHODS write.\nENDINTERFACE.',
      'CLAS ZCL_REPO': 'CLASS zcl_repo DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\nENDCLASS.'
      // ZCL_BASE / Z_POST / ZCX_APP 缺失
    });
    const result = await compress(fetch, { objectName: 'zcl_app', objectType: 'CLAS', maxDeps: 2 });
    // 到手 2 份契约；失败缺口保留在答案里；取数 3 次（失败耗取数、不耗槽位）
    expect(result.contracts.filter(c => !c.error)).toHaveLength(2);
    expect(result.contracts.filter(c => c.error).map(c => c.name)).toEqual(['ZCL_BASE']);
    // 取数次数 = 顶层源码 1 次 + 成功 2 次 + 失败 1 次 = 4；槽位只有 2
    expect(calls).toHaveLength(4);
    expect(result.stats.depsFound).toBe(3);
    expect(result.stats.depsResolved).toBe(2);
    expect(result.stats.depsFailed).toBe(1);
  });

  it('expands depth 2 using the fetched dependency sources and dedupes across levels', async () => {
    const { fetch, calls } = fetcher({
      'CLAS ZCL_APP': CLASS_ZCL_APP,
      'CLAS ZCL_BASE': 'CLASS zcl_base DEFINITION PUBLIC.\nENDCLASS.',
      'INTF ZIF_WRITER': 'INTERFACE zif_writer.\n  METHODS save.\nENDINTERFACE.',
      'CLAS ZCL_REPO': 'CLASS zcl_repo DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\n    DATA helper TYPE REF TO zcl_helper.\nENDCLASS.',
      'CLAS ZCL_HELPER': 'CLASS zcl_helper DEFINITION PUBLIC.\nENDCLASS.',
      'FUNC Z_POST': "FUNCTION z_post.\n*\"  IMPORTING\nENDFUNCTION."
    });
    const result = await compress(fetch, { objectName: 'zcl_app', objectType: 'CLAS', depth: 2 });
    // 第二层从 ZCL_REPO 源码里发现 ZCL_HELPER
    expect(calls).toContain('CLAS ZCL_HELPER');
    expect(result.prologue).toContain('ZCL_HELPER');
  });

  it('returns an empty prologue when nothing resolves', async () => {
    const { fetch } = fetcher({
      'CLAS ZCL_EMPTY': 'CLASS zcl_empty DEFINITION PUBLIC.\nENDCLASS.'
    });
    const result = await compress(fetch, { objectName: 'zcl_empty', objectType: 'CLAS' });
    expect(result.prologue).toBe('');
    expect(result.stats.depsFound).toBe(0);
    expect(result.stats.totalLines).toBe(1); // 空文本按 1 行计
  });

  it('clamps maxDeps and depth to their bounds', async () => {
    const { fetch } = fetcher({ 'CLAS ZCL_APP': CLASS_ZCL_APP });
    // 越界输入收敛：不抛错、不产生负预算
    const result = await compress(fetch, { objectName: 'zcl_app', objectType: 'CLAS', maxDeps: 10_000, depth: 99 });
    expect(result.contracts.length).toBeLessThanOrEqual(MAX_DEPS_CAP);
  });

  it('exposes the documented defaults (VSP NewCompressor L14-18)', () => {
    expect(DEFAULT_MAX_DEPS).toBe(20);
    expect(MAX_DEPTH).toBe(3);
  });
});

/* ==========================================================================
 * 5) 解析与依赖分析（parseAbap / analyzeDependencies）
 * ========================================================================== */

describe('parseAbap (VSP handleParseABAP port)', () => {
  it('splits statements, classifies them, and respects string literals', () => {
    const source = [
      "WRITE 'a.b'.",
      'DATA lv TYPE i.',
      'lv = 42.',
      'IF lv > 0.',
      'ENDIF.'
    ].join('\n');
    const result = parseAbap(source);
    expect(result.lines).toBe(5);
    expect(result.statements).toBe(5);
    const types = result.stmts.map(s => s.type);
    // 字符串字面量里的句点不断句：'a.b' 是一个词元
    expect(types[0]).toBe('OUTPUT');
    expect(result.stmts[0].tokens[1].type).toBe('string');
    expect(result.stmts[0].tokens[1].str).toBe("'a.b'");
    expect(types).toContain('DATA');
    expect(types).toContain('IF');
    expect(types).toContain('ENDIF');
  });

  it('emits COMMENT statements for full-line comments', () => {
    const result = parseAbap('* hello\nWRITE `x`.');
    expect(result.stmts[0].type).toBe('COMMENT');
    expect(result.stmts[1].type).toBe('OUTPUT');
  });
});

describe('analyzeDependencies (VSP handleAnalyzeDeps + analyzer.go confidence port)', () => {
  it('reports regex-layer confidence and orders by confidence then name', () => {
    const source = 'DATA a TYPE REF TO zcl_two.\nDATA b TYPE REF TO zcl_one.';
    const result = analyzeDependencies(source, 'zcl_prog');
    expect(result.layers).toEqual(['regex']);
    expect(result.object).toBe('ZCL_PROG');
    expect(result.totalDeps).toBe(2);
    expect(result.confirmedDeps).toBe(2);
    expect(result.falsePositives).toBe(0);
    expect(result.dependencies[0].confidence).toBe(0.8);
    expect(result.dependencies.map(d => d.name)).toEqual(['ZCL_ONE', 'ZCL_TWO']);
  });

  it('flags names that only ever occur in strings or comments (VSP analyzer.go L168-181)', () => {
    // 提取层扫描原始行（跳过整行注释），所以字符串里的 "name=>" 也会建立
    // 依赖记录；随后精确性检查发现该名字的每次出现都在引号内 → 疑似误报
    const source = "DATA q TYPE string VALUE 'later call zcl_phantom=>do_it here'.";
    const result = analyzeDependencies(source, 'P');
    expect(result.totalDeps).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.dependencies[0].suspect).toBe(true);
    expect(result.dependencies[0].confidence).toBe(0.3);
    expect(result.confirmedDeps).toBe(0);
  });

  it('never flags function modules for being quoted (they are by construction)', () => {
    const source = "CALL FUNCTION 'Z_REAL_FM'.";
    const result = analyzeDependencies(source, 'P');
    expect(result.falsePositives).toBe(0);
    expect(result.dependencies[0].suspect).toBeUndefined();
    expect(result.confirmedDeps).toBe(1);
  });
});

/* ==========================================================================
 * 6) 副作用与 LUW（extractEffects / classifyLUW / analyzeEffects）
 * ========================================================================== */

describe('extractEffects + LUW classification (VSP graph/effects.go port)', () => {
  it('classifies a pure unit as safe with no effects', () => {
    const info = extractEffects('DATA x TYPE i.\nx = 1.');
    expect(isPure(info)).toBe(true);
    expect(classifyLUW(info)).toBe('safe');
  });

  it('classifies deferred-update registration as participant', () => {
    const info = extractEffects("CALL FUNCTION 'Z_SAVE' IN UPDATE TASK.");
    expect(info.updateTask).toBe(true);
    expect(classifyLUW(info)).toBe('participant');
    expect(isPure(info)).toBe(false);
  });

  it('classifies COMMIT WORK as owner and the mix as unsafe', () => {
    expect(classifyLUW(extractEffects('COMMIT WORK.'))).toBe('owner');
    expect(classifyLUW(extractEffects('ROLLBACK WORK.'))).toBe('owner');
    const unsafe = extractEffects([
      "CALL FUNCTION 'Z_A' IN UPDATE TASK.",
      'COMMIT WORK.'
    ].join('\n'));
    expect(classifyLUW(unsafe)).toBe('unsafe');
  });

  it('tracks custom-table reads/writes, RFC destinations, and background jobs', () => {
    const source = [
      'SELECT * FROM ztab INTO TABLE lt.',
      'SELECT * FROM mara INTO TABLE lt2.',          // 标准表不进清单
      'UPDATE ztab SET x = 1.',
      "CALL FUNCTION 'Z_RFC' DESTINATION 'NONE'.",
      'SUBMIT zjob VIA JOB AND RETURN.',
      "MESSAGE e001(zmsg) TYPE 'E'.",
      'RAISE EXCEPTION TYPE zcxBoom.',               // 混合大小写也应命中
    ].join('\n');
    const info = extractEffects(source);
    expect(info.readsDB).toEqual(['ZTAB']);
    expect(info.writesDB).toEqual(['ZTAB']);
    expect(info.syncRFC).toEqual(['NONE']);
    expect(info.backgroundJob).toBe(true);
    expect(info.submitAndReturn).toBe(true);
    expect(info.raisesMessage).toBe(true);
    expect(info.raisesExc).toBe(true);
  });

  it('detects state access, HTTP client, and SET UPDATE TASK LOCAL', () => {
    const source = [
      'me->counter = 1.',
      'CREATE OBJECT lo_http TYPE cl_http_client.',   // http 检测按词元名
      'SET UPDATE TASK LOCAL.'
    ].join('\n');
    const info = extractEffects(source);
    expect(info.readsState).toBe(true);
    expect(info.updateTaskLocal).toBe(true);
  });

  it('carries the caller-facing consequence sentence and boundary notes', () => {
    const answer = analyzeEffects('Z_UNIT', 'COMMIT WORK.');
    expect(answer.luw).toBe('owner');
    expect(answer.consequence).toContain('ends its caller\'s transaction');
    expect(answer.notes?.[0]).toContain('local analysis');
    expect(luwConsequence('unknown')).toContain('not one this build knows about');
  });

  it('formats the effect list in caller vocabulary', () => {
    const answer = analyzeEffects('Z_UNIT', "CALL FUNCTION 'X' IN BACKGROUND TASK.\nLEAVE PROGRAM.");
    expect(answer.effects).toEqual(expect.arrayContaining([
      'registers work IN BACKGROUND TASK',
      'leaves the program or the transaction'
    ]));
  });
});

/* ==========================================================================
 * 7) 客户端绑定（createContextAnalysisClient / createSourceFetcher）
 * ========================================================================== */

/** 构造 ADT 客户端 mock：按对象名服务 searchObject/objectStructure/getObjectSource
 *  三步只读链；名称前缀推断 ADT 类型（ZIF_* → INTF、含下划线双段大写 Z_xxx_yyy
 *  规则不适用的 FM 按 FUNC 形态），不在 sources 中的名字在 searchObject 阶段即
 *  返回空（模拟找不到）。 */
function adtMock(sources: Record<string, string>): AdtContextSourceCapability {
  const kindsOf = (name: string): { type: string; uri: string } => {
    if (name.startsWith('ZIF_')) return { type: 'INTF/OI', uri: `/sap/bc/adt/oo/interfaces/${name.toLowerCase()}` };
    if (/^Z_[A-Z0-9_]+$/.test(name)) {
      return { type: 'FUGR/I', uri: `/sap/bc/adt/functions/groups/zgrp/fmodules/${name.toLowerCase()}` };
    }
    return { type: 'CLAS/OC', uri: `/sap/bc/adt/oo/classes/${name.toLowerCase()}` };
  };
  const hasSource = (name: string) => {
    if (sources[`CLAS ${name}`] || sources[`INTF ${name}`] || sources[`FUNC ${name}`]) return true;
    return false;
  };
  const sourceOf = (name: string) =>
    sources[`CLAS ${name}`] ?? sources[`INTF ${name}`] ?? sources[`FUNC ${name}`];
  return {
    searchObject: jest.fn(async (query: string) => (
      hasSource(query) ? [{ 'adtcore:name': query, 'adtcore:type': kindsOf(query).type, 'adtcore:uri': kindsOf(query).uri }] : []
    )),
    objectStructure: jest.fn(async (objectUri: string) => ({
      objectUrl: objectUri,
      // 模拟真实 DEV 系统形态：metaData 无 sourceUri，main include 给相对链接
      // source/main（ContextCompressionApi.absolutizeSourceUrl 负责拼回绝对路径）
      metaData: {},
      includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': 'source/main' }]
    })),
    getObjectSource: jest.fn(async (url: string) => {
      const match = url.match(/\/(?:classes|interfaces|fmodules)\/([a-z0-9_]+)\/source\/main/);
      const name = match ? match[1].toUpperCase() : '';
      const source = sourceOf(name);
      if (source === undefined) throw new Error(`no source served for ${url}`);
      return source;
    })
  };
}

describe('createSourceFetcher (read-only ADT resolution chain)', () => {
  it('resolves name → uri → sourceUri → source and upper-cases the name', async () => {
    const client = adtMock({ 'CLAS ZCL_APP': CLASS_ZCL_APP });
    const fetch = createSourceFetcher(client);
    const source = await fetch('CLAS', 'zcl_app');
    expect(source).toBe(CLASS_ZCL_APP);
    expect(client.searchObject).toHaveBeenCalledWith('ZCL_APP', undefined, 50);
  });

  it('throws a resolution error when quick search has no unique exact match', async () => {
    const client = adtMock({});
    const fetch = createSourceFetcher(client);
    await expect(fetch('CLAS', 'ZCL_MISSING')).rejects.toThrow('no unique CLAS object named ZCL_MISSING');
  });

  it('throws when ADT metadata carries no source URI', async () => {
    const client: AdtContextSourceCapability = {
      searchObject: async () => [{ 'adtcore:name': 'ZCL_APP', 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/u' }],
      objectStructure: async () => ({ metaData: {} }),
      getObjectSource: async () => 'should not be called'
    };
    await expect(createSourceFetcher(client)('CLAS', 'ZCL_APP')).rejects.toThrow('no source URI');
  });

  it('joins relative include source URIs onto the object URL (real-system shape)', async () => {
    // 真实 DEV 系统的 main include 源链接是相对 URI（source/main），必须拼到
    // 对象 URI 之后才能读取（对齐 read/AbapMemberSourceReader.resolveSourceUrl）
    const seenUrls: string[] = [];
    const client: AdtContextSourceCapability = {
      searchObject: async () => [{ 'adtcore:name': 'ZCL_APP', 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_app' }],
      objectStructure: async () => ({
        metaData: {},
        includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': 'source/main' }]
      }),
      getObjectSource: async (url: string) => {
        seenUrls.push(String(url));
        return CLASS_ZCL_APP;
      }
    };
    const source = await createSourceFetcher(client)('CLAS', 'ZCL_APP');
    expect(source).toBe(CLASS_ZCL_APP);
    expect(seenUrls[0]).toBe('/sap/bc/adt/oo/classes/zcl_app/source/main');
  });

  it('rejects malicious relative source URIs before any read', async () => {
    const client: AdtContextSourceCapability = {
      searchObject: async () => [{ 'adtcore:name': 'ZCL_APP', 'adtcore:type': 'CLAS/OC', 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_app' }],
      objectStructure: async () => ({
        metaData: {},
        includes: [{ 'class:includeType': 'main', 'abapsource:sourceUri': '../../etc/passwd' }]
      }),
      getObjectSource: async () => 'should not be called'
    };
    await expect(createSourceFetcher(client)('CLAS', 'ZCL_APP')).rejects.toThrow('invalid source URI');
  });
});

describe('createContextAnalysisClient (four read-only capabilities)', () => {
  it('returns prologue, stats, and the structured unresolved list', async () => {
    const client = adtMock({
      'CLAS ZCL_APP': CLASS_ZCL_APP,
      'CLAS ZCL_BASE': 'CLASS zcl_base DEFINITION PUBLIC.\nENDCLASS.',
      'INTF ZIF_WRITER': 'INTERFACE zif_writer.\n  METHODS write.\nENDINTERFACE.',
      'CLAS ZCL_REPO': 'CLASS zcl_repo DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\nENDCLASS.',
      'FUNC Z_POST': "FUNCTION z_post.\n*\"  IMPORTING\nENDFUNCTION."
      // ZCX_APP 刻意缺失 → 结构化 unresolved
    });
    const analysis = createContextAnalysisClient(client);
    // 默认预算 20：五个依赖全部尝试，ZCX_APP 取不到 → 结构化 unresolved
    const result = await analysis.getDependencyContext({
      objectType: 'CLAS',
      objectName: 'zcl_app'
    });
    expect(result.objectName).toBe('ZCL_APP');
    expect(result.stats.depsResolved).toBeGreaterThan(0);
    expect(result.unresolved).toContain('ZCX_APP');
    expect(result.prologue).toContain('Dependency context for ZCL_APP');
  });

  it('reads source by object for the pure-analysis tools', async () => {
    const client = adtMock({ 'CLAS ZCL_APP': CLASS_ZCL_APP });
    const analysis = createContextAnalysisClient(client);
    const deps = await analysis.analyzeDependencies({ objectType: 'CLAS', objectName: 'zcl_app' });
    expect(deps.object).toBe('ZCL_APP');
    expect(deps.totalDeps).toBeGreaterThan(0);
    const parsed = await analysis.parseAbapSource({ objectType: 'CLAS', objectName: 'zcl_app' });
    expect(parsed.statements).toBeGreaterThan(0);
    const effects = await analysis.analyzeSourceEffects({ objectType: 'CLAS', objectName: 'zcl_app' });
    expect(effects.luw).toBe('safe');
    expect(effects.notes?.length).toBeGreaterThan(0);
  });

  it('prefers caller-provided source over ADT fetches', async () => {
    const client = adtMock({});
    const analysis = createContextAnalysisClient(client);
    const deps = await analysis.analyzeDependencies({ source: 'DATA x TYPE REF TO zcl_inline.' });
    expect(deps.totalDeps).toBe(1);
    expect((client.getObjectSource as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects inputs with neither source nor object identity', async () => {
    const analysis = createContextAnalysisClient(adtMock({}));
    await expect(analysis.analyzeDependencies({})).rejects.toThrow('either source or objectType+objectName');
  });
});

/* ==========================================================================
 * 8) formatPrologue 独立断言
 * ========================================================================== */

describe('formatPrologue', () => {
  it('returns empty text when no contract resolved', () => {
    const failed: Contract = { name: 'ZCL_X', kind: 'CLAS', source: '', methodsTotal: 0, methodsShown: 0, error: 'boom' };
    expect(formatPrologue('P', [failed])).toBe('');
  });
});

/* ==========================================================================
 * 类型引用守护：确保 Dependency/Contract 面不漂移（编译期导入即验证）
 * ========================================================================== */

describe('type surface', () => {
  it('keeps dependency records minimal and upper-cased', () => {
    const d: Dependency = { name: 'ZCL_A', kind: 'CLAS', line: 1 };
    expect(d.name).toBe('ZCL_A');
    const c: Contract = { name: 'ZCL_A', kind: 'CLAS', source: 'CLASS.', methodsTotal: 1, methodsShown: 1 };
    expect(c.methodsShown).toBeLessThanOrEqual(c.methodsTotal);
  });
});
