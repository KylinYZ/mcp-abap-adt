/**
 * 受控 UI5/Fiori BSP filestore 写入工作流（Ui5WriteWorkflow）——F5：关闭矩阵行
 * ui5.write（VSP surface: SAP(create|edit|delete, target=UI5_APP|UI5_FILE)）。
 *
 * 任务语义（对齐 VSP pkg/adt/ui5.go L273-419 四个写操作，kind 分派）：
 *   - create_app:  POST {base}?corrNr=<t>（bsp:application XML）
 *   - upload_file: PUT {base}/<APP%2fPATH>/content（整文件覆盖）
 *   - delete_file: DELETE {base}/<APP%2fPATH>
 *   - delete_app:  DELETE {base}/<APP>?corrNr=<t>（应用级删除，破坏面最大）
 *
 * 安全模型（与文本池受控链同面）：
 * 1. preview：只读预检（应用/文件存在性与期望状态 fail-closed 核验、命名空间
 *    白名单、上传内容上限）→ 冻结 immutable plan（旧状态快照/内容 hash/TTL/
 *    上下文）。delete_app 必须冻结文件数作为影响面证据。
 * 2. applyConfirmed：仅接受 server 生成的 planId；apply 前做一次漂移复核
 *    （目标状态与 preview 时不一致即 STATE_DRIFT，拒绝执行）；单次执行 →
 *    readback 比对；PUT/DELETE 发出后异常按 UNKNOWN_OUTCOME 终结（可能已写，
 *    不自动重试）。
 * 3. 同值短路：upload_file 新内容与现值逐字节一致时 sameValue=true 不写（仍记审计）。
 *
 * 与文本池链的差异：filestore 写不走 ABAP workbench 对象锁（BSP 容器操作，
 * VSP 同款无锁），事务边界由 preview 冻结旧状态 + apply readback 比对补齐；
 * 传输号（corrNr）仅 create_app/delete_app 需要且可选。
 */
import { SafeAbapError } from './errors.js';
import type { SafetyPolicy } from './SafetyPolicy.js';
import type { AuditEvent } from './AuditLogger.js';
import { isAdtNotFound, MAX_UPLOAD_BYTES } from '../adt/Ui5FilestoreApi.js';

/** 四个受控写操作（kind 分派，对齐 VSP ui5.go 的四个写函数）。 */
export type Ui5WriteOperationKind = 'create_app' | 'upload_file' | 'delete_file' | 'delete_app'

/** preview 只读预检冻结的旧状态快照（readback 与漂移复核的基线）。 */
export interface Ui5WriteOldState {
  /** 应用是否存在（delete/upload 必须存在、create 必须不存在）。 */
  appExists: boolean
  /** 应用文件树条目数（delete_app 的影响面证据；其余 kind 可缺省）。 */
  fileCount?: number
  /** 目标文件是否存在（upload_file/delete_file）。 */
  fileExists?: boolean
  /** 目标文件字节数（upload_file 的 sameValue 判定佐证）。 */
  fileSize?: number
}

/** 受控 UI5 写入的入参（kind 决定哪些字段必填，preview 内逐 kind 校验）。 */
export interface Ui5WriteInput {
  kind: Ui5WriteOperationKind
  /** 目标 UI5 BSP 应用名（白名单：A-Z0-9_$，可选单级命名空间 /NS/APP）。 */
  appName: string
  /** create_app：应用描述（XML 转义在 ADT 层完成）。 */
  description?: string
  /** create_app：开发包名（必填）。 */
  packageName?: string
  /** upload_file/delete_file：相对应用根的文件路径。 */
  filePath?: string
  /** upload_file：文件内容（UTF-8 文本，≤2 MiB）。 */
  content?: string
  /** upload_file：Content-Type（缺省 application/octet-stream）。 */
  contentType?: string
  /** create_app/delete_app 可选传输号（corrNr）。 */
  transport?: string
}

/** plan 的对外视图（不含上传内容全文——用 hash/字节数代替，避免 2 MiB 回显）。 */
export interface Ui5WritePlanView {
  ui5WritePlanId: string
  createdAt: string
  expiresAt: string
  status: 'PREVIEWED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'EXPIRED'
  systemHost: string
  client: string
  systemRole: string
  toolProfile: string
  kind: Ui5WriteOperationKind
  appName: string
  filePath?: string
  packageName?: string
  description?: string
  transport?: string
  oldState: Ui5WriteOldState
  contentSha256?: string
  contentBytes?: number
  payloadHash: string
}

/** plan 的内部形态（content 全文仅在服务端内存，apply 执行用）。 */
interface Ui5WritePlan extends Ui5WritePlanView {
  expiresAtMs: number
  content?: string
  contentType?: string
  context: { systemHost: string; client: string; sapUser: string; systemRole: string; toolProfile: string }
}

export interface Ui5WriteAuditSink {
  append(event: AuditEvent): Promise<void>
}

/** 上下文形态（plan 与当前会话绑定，跨系统/跨 profile 复用 plan 一律拒绝）。 */
export interface Ui5WriteContext {
  systemHost: string
  client: string
  sapUser: string
  systemRole: string
  toolProfile: string
}

const DEFAULT_TTL_MS = 15 * 60 * 1000
const PACKAGE_NAME_PATTERN = /^\$?[A-Z][A-Z0-9_]{0,29}$/
const KINDS: readonly Ui5WriteOperationKind[] = ['create_app', 'upload_file', 'delete_file', 'delete_app']

/** 稳定 hash（plan payloadHash / 内容 hash）。 */
async function sha256(payload: unknown): Promise<string> {
  const { createHash } = await import('crypto')
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * 受控 UI5 filestore 写入工作流。
 * deps 的 client 必须绑定写域 stateful 主会话（preview/apply 同会话，readback
 * 同视图）；调用方（接线层）负责 DEV 角色 + development/development-workbench
 * profile 的目录门控，本类只做任务语义与状态机。
 */
export class Ui5WriteWorkflow {
  private readonly plans = new Map<string, Ui5WritePlan>()

  constructor(
    private readonly deps: {
      /** 写域主会话绑定的一体化客户端（写操作 + readback 只读）。 */
      client: {
        ui5CreateApp(input: { appName: string; description?: string; packageName: string; transport?: string }): Promise<void>
        ui5UploadFile(input: { appName: string; filePath: string; content: string; contentType?: string }): Promise<void>
        ui5DeleteFile(input: { appName: string; filePath: string }): Promise<void>
        ui5DeleteApp(input: { appName: string; transport?: string }): Promise<void>
        ui5GetApp(input: { appName: string }): Promise<{ appName: string; files: Array<{ path: string; type: string }>; feedEntries: number }>
        ui5GetFileContent(input: { appName: string; filePath: string }): Promise<{ appName: string; filePath: string; content: string; size: number }>
      }
      policy: SafetyPolicy
      audit: Ui5WriteAuditSink
      now?: () => number
    },
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {}

  private context(): Ui5WriteContext {
    return {
      systemHost: this.deps.policy.systemHost,
      client: this.deps.policy.client,
      sapUser: this.deps.policy.sapUser,
      systemRole: this.deps.policy.systemRole,
      toolProfile: this.deps.policy.toolProfile
    };
  }

  /** 读应用存在性与文件树（404 归一化为 appExists=false，其余错误上抛）。 */
  private async readAppState(appName: string): Promise<Ui5WriteOldState> {
    try {
      const app = await this.deps.client.ui5GetApp({ appName });
      return { appExists: true, fileCount: app.files.length };
    } catch (error) {
      if (isAdtNotFound(error)) return { appExists: false };
      throw error;
    }
  }

  /** 读文件存在性与字节数（404 归一化为 fileExists=false，其余错误上抛）。 */
  private async readFileState(appName: string, filePath: string): Promise<{ fileExists: boolean; fileSize?: number; content?: string }> {
    try {
      const file = await this.deps.client.ui5GetFileContent({ appName, filePath });
      return { fileExists: true, fileSize: file.size, content: file.content };
    } catch (error) {
      if (isAdtNotFound(error)) return { fileExists: false };
      throw error;
    }
  }

  /** preview：只读预检并冻结 immutable plan。 */
  async preview(input: Ui5WriteInput): Promise<Record<string, unknown>> {
    const kind = String(input?.kind ?? '').trim() as Ui5WriteOperationKind;
    if (!KINDS.includes(kind)) {
      throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `kind must be one of ${KINDS.join(', ')}.`);
    }
    // 应用名与命名空间白名单：复用 ADT 层规范化（含大写/形态校验），再过
    // SafetyPolicy 的 allowedNamespaces/host/client 面。
    const { normalizeUi5AppName, normalizeUi5FilePath } = await import('../adt/Ui5FilestoreApi.js');
    const appName = normalizeUi5AppName(input?.appName, 'previewUi5Operation');
    this.deps.policy.assertReadAllowed(appName);

    const planBase = {
      kind,
      appName,
      ...(input.transport ? { transport: String(input.transport).trim().toUpperCase() } : {})
    };
    let oldState: Ui5WriteOldState;
    let content: string | undefined;
    let contentType: string | undefined;

    if (kind === 'create_app') {
      const packageName = String(input?.packageName ?? '').trim().toUpperCase();
      if (!PACKAGE_NAME_PATTERN.test(packageName)) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `packageName "${String(input?.packageName ?? '')}" is not a valid package name.`);
      }
      this.deps.policy.assertReadAllowed(packageName);
      const description = input?.description === undefined ? '' : String(input.description);
      if (description.length > 60) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'description must be at most 60 characters (adtcore:description attribute).');
      }
      // fail-closed：目标应用必须不存在（重复创建会污染 filestore）
      oldState = await this.readAppState(appName);
      if (oldState.appExists) {
        throw new SafeAbapError('OBJECT_ALREADY_EXISTS', 'PREVIEW', `UI5 app ${appName} already exists (${oldState.fileCount ?? 0} entries). Preview refuses to duplicate it.`);
      }
      Object.assign(planBase, { packageName, description });
    } else if (kind === 'upload_file') {
      const filePath = normalizeUi5FilePath(input?.filePath, 'previewUi5Operation');
      const rawContent = typeof input?.content === 'string' ? input.content : '';
      if (!rawContent) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', 'content is required for upload_file.');
      }
      if (Buffer.byteLength(rawContent, 'utf8') > MAX_UPLOAD_BYTES) {
        throw new SafeAbapError('VALIDATION_FAILED', 'PREVIEW', `content exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`);
      }
      contentType = input?.contentType === undefined ? undefined : String(input.contentType);
      // 上传目标应用必须已存在（filestore 不自动建应用——与 VSP 行为一致）
      oldState = await this.readAppState(appName);
      if (!oldState.appExists) {
        throw new SafeAbapError('OBJECT_NOT_FOUND', 'PREVIEW', `UI5 app ${appName} does not exist; upload_file cannot create it (use kind=create_app first).`);
      }
      const fileState = await this.readFileState(appName, filePath);
      oldState.fileExists = fileState.fileExists;
      oldState.fileSize = fileState.fileSize;
      content = rawContent;
      Object.assign(planBase, { filePath });
    } else if (kind === 'delete_file') {
      const filePath = normalizeUi5FilePath(input?.filePath, 'previewUi5Operation');
      oldState = await this.readAppState(appName);
      if (!oldState.appExists) {
        throw new SafeAbapError('OBJECT_NOT_FOUND', 'PREVIEW', `UI5 app ${appName} does not exist.`);
      }
      const fileState = await this.readFileState(appName, filePath);
      // fail-closed：删除目标必须存在（幂等删除不成立——避免掩盖他人已删的现实）
      if (!fileState.fileExists) {
        throw new SafeAbapError('OBJECT_NOT_FOUND', 'PREVIEW', `file ${filePath} does not exist in app ${appName}.`);
      }
      oldState.fileExists = true;
      oldState.fileSize = fileState.fileSize;
      Object.assign(planBase, { filePath });
    } else {
      // delete_app：破坏面最大——必须存在且冻结文件数作为影响面证据
      oldState = await this.readAppState(appName);
      if (!oldState.appExists) {
        throw new SafeAbapError('OBJECT_NOT_FOUND', 'PREVIEW', `UI5 app ${appName} does not exist.`);
      }
    }

    const now = this.deps.now?.() ?? Date.now();
    const contentSha256 = content === undefined ? undefined : await sha256(content);
    const payloadHash = await sha256({
      ...planBase,
      ...(contentSha256 ? { contentSha256 } : {}),
      contentType
    });
    const plan: Ui5WritePlan = {
      ui5WritePlanId: globalThis.crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'PREVIEWED',
      ...this.context(),
      ...planBase,
      oldState,
      ...(content !== undefined ? { contentSha256, contentBytes: Buffer.byteLength(content, 'utf8') } : {}),
      payloadHash,
      expiresAtMs: now + this.ttlMs,
      ...(content !== undefined ? { content, contentType } : {}),
      context: this.context()
    };
    this.plans.set(plan.ui5WritePlanId, plan);
    await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_PREVIEW_CREATED', true));
    return { status: 'preview', plan: this.publicView(plan), confirmationRequired: true };
  }

  /** apply：按已确认的 plan 单次执行（漂移复核 → 执行 → readback）。 */
  async applyConfirmed(ui5WritePlanId: string): Promise<Record<string, unknown>> {
    const context = this.context();
    const plan = this.plans.get(ui5WritePlanId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'ui5-write-plan', 'UI5 write plan does not exist.');
    if (plan.context.systemHost !== context.systemHost || plan.context.client !== context.client
      || plan.context.sapUser !== context.sapUser || plan.context.systemRole !== context.systemRole
      || plan.context.toolProfile !== context.toolProfile) {
      throw new SafeAbapError('POLICY_DENIED', 'ui5-write-plan', 'Plan belongs to a different SAP context.');
    }
    if (plan.expiresAtMs <= (this.deps.now?.() ?? Date.now())) {
      plan.status = 'EXPIRED';
    }
    if (plan.status === 'EXPIRED') {
      throw new SafeAbapError('PLAN_EXPIRED', 'ui5-write-plan', 'UI5 write plan has expired.');
    }
    if (plan.status !== 'PREVIEWED') {
      throw new SafeAbapError('PLAN_ALREADY_CONSUMED', 'ui5-write-plan', `UI5 write plan is already ${plan.status.toLowerCase()}.`);
    }

    try {
      // 漂移复核：preview 之后目标状态可能被他人改动；每 kind 一次读，与
      // preview 冻结的 oldState 不符即 STATE_DRIFT（写尚未发出，安全失败）。
      // upload_file 的同值短路也在此分支完成（内容一致时不执行写）。
      switch (plan.kind) {
        case 'create_app': {
          const app = await this.readAppState(plan.appName);
          if (app.appExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `UI5 app ${plan.appName} was absent at preview but exists now.`);
          }
          break;
        }
        case 'upload_file': {
          const app = await this.readAppState(plan.appName);
          if (!app.appExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `UI5 app ${plan.appName} existed at preview but is gone now.`);
          }
          const before = await this.readFileState(plan.appName, plan.filePath!);
          if (before.fileExists && before.content === plan.content) {
            plan.status = 'SUCCEEDED';
            await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_SAME_VALUE', true));
            return { status: 'success', plan: this.publicView(plan), sameValue: true };
          }
          if (!before.fileExists && plan.oldState.fileExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `file ${plan.filePath} existed at preview but is gone now.`);
          }
          if (before.fileExists && plan.oldState.fileExists === false) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `file ${plan.filePath} was absent at preview but exists now.`);
          }
          break;
        }
        case 'delete_file': {
          const app = await this.readAppState(plan.appName);
          if (!app.appExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `UI5 app ${plan.appName} existed at preview but is gone now.`);
          }
          const before = await this.readFileState(plan.appName, plan.filePath!);
          if (!before.fileExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `file ${plan.filePath} existed at preview but is gone now.`);
          }
          break;
        }
        case 'delete_app': {
          const app = await this.readAppState(plan.appName);
          if (!app.appExists) {
            throw new SafeAbapError('STATE_DRIFT', 'APPLY', `UI5 app ${plan.appName} existed at preview but is gone now.`);
          }
          break;
        }
      }

      // 单次执行 + readback 比对（执行体按 kind 分派）
      switch (plan.kind) {
        case 'create_app':
          await this.deps.client.ui5CreateApp({
            appName: plan.appName,
            description: plan.description ?? '',
            packageName: plan.packageName!,
            ...(plan.transport ? { transport: plan.transport } : {})
          });
          {
            const after = await this.readAppState(plan.appName);
            if (!after.appExists) {
              throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `app ${plan.appName} still absent after create.`);
            }
          }
          break;
        case 'upload_file':
          await this.deps.client.ui5UploadFile({
            appName: plan.appName,
            filePath: plan.filePath!,
            content: plan.content!,
            ...(plan.contentType ? { contentType: plan.contentType } : {})
          });
          {
            const after = await this.readFileState(plan.appName, plan.filePath!);
            if (!after.fileExists || after.content !== plan.content) {
              throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `file ${plan.filePath} readback does not match uploaded content.`);
            }
          }
          break;
        case 'delete_file':
          await this.deps.client.ui5DeleteFile({ appName: plan.appName, filePath: plan.filePath! });
          {
            const after = await this.readFileState(plan.appName, plan.filePath!);
            if (after.fileExists) {
              throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `file ${plan.filePath} still present after delete.`);
            }
          }
          break;
        case 'delete_app':
          await this.deps.client.ui5DeleteApp({
            appName: plan.appName,
            ...(plan.transport ? { transport: plan.transport } : {})
          });
          {
            const after = await this.readAppState(plan.appName);
            if (after.appExists) {
              throw new SafeAbapError('VERIFICATION_FAILED', 'readback', `app ${plan.appName} still present after delete.`);
            }
          }
          break;
      }
    } catch (error) {
      // 写尚未发出（漂移/校验类）→ 状态停在 FAILED，可重新 preview
      if (error instanceof SafeAbapError && ['STATE_DRIFT', 'PLAN_EXPIRED'].includes(error.code)) {
        plan.status = 'FAILED';
        await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_FAILED', false, { errorSummary: error.message }));
        throw error;
      }
      if (error instanceof SafeAbapError && error.code === 'VERIFICATION_FAILED') {
        plan.status = 'FAILED';
        await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_FAILED', false, { errorSummary: error.message }));
        throw error;
      }
      // 请求发出后的失败：结果未知——终结不重试。底层错误透传进 message
      const underlying = error instanceof Error ? error.message : String(error);
      plan.status = 'UNKNOWN_OUTCOME';
      try {
        await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_UNKNOWN', false, { unknownOutcome: true, errorSummary: underlying }));
      } catch { /* 审计失败不掩盖主错误 */ }
      throw new SafeAbapError('UNKNOWN_OUTCOME', 'EXECUTE', `The UI5 write outcome is unknown (${underlying.slice(0, 200)}). Review the filestore before retrying.`);
    }

    plan.status = 'SUCCEEDED';
    await this.deps.audit.append(this.auditEvent(plan, 'UI5_WRITE_COMPLETED', true));
    return { status: 'success', plan: this.publicView(plan), sameValue: false };
  }

  /** 本地状态查询。 */
  status(planId: string): Ui5WritePlanView {
    const plan = this.plans.get(planId);
    if (!plan) throw new SafeAbapError('PLAN_NOT_FOUND', 'ui5-write-plan', 'UI5 write plan does not exist.');
    return this.publicView(plan);
  }

  private auditEvent(plan: Ui5WritePlan, eventType: string, success: boolean, extra?: Partial<AuditEvent>): AuditEvent {
    return {
      correlationId: plan.ui5WritePlanId,
      eventType,
      systemHost: plan.context.systemHost,
      client: plan.context.client,
      systemRole: plan.context.systemRole,
      resultSummary: `${plan.kind} ${plan.appName}${plan.filePath ? `/${plan.filePath}` : ''}: ${plan.status}`,
      success,
      ...extra
    } as AuditEvent;
  }

  private publicView(plan: Ui5WritePlan): Ui5WritePlanView {
    const { ui5WritePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      kind, appName, filePath, packageName, description, transport, oldState, contentSha256, contentBytes, payloadHash } = plan;
    return {
      ui5WritePlanId, createdAt, expiresAt, status, systemHost, client, systemRole, toolProfile,
      kind, appName, oldState, payloadHash,
      ...(filePath ? { filePath } : {}),
      ...(packageName ? { packageName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(transport ? { transport } : {}),
      ...(contentSha256 ? { contentSha256, contentBytes } : {})
    };
  }
}
