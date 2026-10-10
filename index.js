/**
 * provider-quote — 包根转发入口。
 *
 * 宿主实现放在 `lib/host.js`（包清单的 `exports["."]` 指向它），
 * 这个文件让「按包内相对路径 import」也拿到同一份实现。
 */
export * from './lib/host.js';
