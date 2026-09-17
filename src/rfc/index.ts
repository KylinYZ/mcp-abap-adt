/**
 * RFC 子项目（rfc-transport-spike）阶段 0 的稳定内部入口。
 *
 * 分层说明：
 * - `connection`：连接参数模型、寻址校验、SAP Router 路由解析（模型占位）。
 * - `types` + `codec`：ABAP 基础类型/结构体/内表的规格模型与按字节布局编解码。
 * - `interface`：FM 接口描述（参数方向/异常）、JSON Schema 生成、入参校验。
 * - `call`：调用请求/结果模型，超时与 AbortSignal 取消（RFC_TIMEOUT）。
 * - `transport`：传输适配器抽象 + LoopbackTransport 内存回环实现。
 * - `pool`：连接池、复用与 keep-alive 状态机（RFC_PING 保活、传输故障剔除）。
 * - `allowlist`：只读 FM 白名单门控（RF_CALL_NOT_ALLOWED 拒绝）。
 *
 * 硬边界：阶段 0 为纯协议层，任何模块都不得发起真实网络请求；
 * 允许调用的 FM 集合由 allowlist 收口，白名单之外一律拒绝。
 */

export * from './errors';
export * from './types';
export * from './codec';
export * from './connection';
export * from './interface';
export * from './call';
export * from './transport';
export * from './pool';
export * from './allowlist';
