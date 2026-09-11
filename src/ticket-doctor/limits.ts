// 跨引擎共享的硬限制常量：工具结果按不可信输入处理，进入证据前必须限长。
// fake 引擎与 pi 适配器使用同一个值，保证两边产出的 Evidence 形状一致。
export const MAX_EXCERPT_CHARS = 200;
