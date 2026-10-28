// 与浏览器共用 UTF-8 字节计数，纯规则不依赖 Node 全局对象。
export const utf8Length = (value) => new TextEncoder().encode(value).byteLength;
