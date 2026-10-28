import * as e from "react";
import { createRoot as t } from "react-dom/client";
import { Fragment as n, jsx as r, jsxs as i } from "react/jsx-runtime";
//#region ../examples/browser-debugger/src/geometry.ts
var a = (e, t, n) => Math.max(t, Math.min(e, Math.max(t, n)));
function o(e, t) {
	let n = Math.min(16, t.width / 20, t.height / 20), r = a(e.width, Math.min(640, t.width - n * 2), t.width - n * 2), i = a(e.height, Math.min(420, t.height - n * 2), t.height - n * 2);
	return {
		width: r,
		height: i,
		x: a(e.x, n, t.width - n - r),
		y: a(e.y, n, t.height - n - i)
	};
}
function s(e) {
	return o({
		x: e.width >= 1200 ? e.width - 1056 : 16,
		y: e.width >= 1200 ? 88 : 64,
		width: e.width >= 1200 ? 1032 : e.width - 32,
		height: e.width >= 1200 ? 640 : 624
	}, e);
}
function c(e, t) {
	let n = o(e, t), r = Math.min(16, t.width / 20, t.height / 20), i = t.width - n.x - n.width, a = t.height - n.y - n.height;
	return {
		...n,
		x: n.x <= 24 && n.x <= i ? r : i <= 24 ? t.width - r - n.width : n.x,
		y: n.y <= 24 && n.y <= a ? r : a <= 24 ? t.height - r - n.height : n.y
	};
}
function l(e, t, n, r) {
	let i = n ? 32 : 8;
	return o({
		...e,
		width: e.width + (t === "ArrowRight" ? i : t === "ArrowLeft" ? -i : 0),
		height: e.height + (t === "ArrowDown" ? i : t === "ArrowUp" ? -i : 0)
	}, r);
}
function u(e, t, n, r) {
	let i = Math.min(16, n.width / 20);
	return {
		x: r ? e + 24 < n.width / 2 ? i : Math.max(i, n.width - 48 - i) : a(e, i, n.width - 48 - i),
		y: a(t, i, n.height - 48 - i)
	};
}
//#endregion
//#region ../examples/browser-debugger/src/style.ts
var d = "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n@layer properties;\n@scope ([data-deviceforge-debugger]) {\n  .visible {\n    visibility: visible;\n  }\n  .absolute {\n    position: absolute;\n  }\n  .fixed {\n    position: fixed;\n  }\n  .relative {\n    position: relative;\n  }\n  .sticky {\n    position: sticky;\n  }\n  .top-0 {\n    top: 0px;\n  }\n  .top-\\[var\\(--df-y\\)\\] {\n    top: var(--df-y);\n  }\n  .right-0 {\n    right: 0px;\n  }\n  .bottom-0 {\n    bottom: 0px;\n  }\n  .left-0 {\n    left: 0px;\n  }\n  .left-\\[var\\(--df-x\\)\\] {\n    left: var(--df-x);\n  }\n  .z-\\[2147483000\\] {\n    z-index: 2147483000;\n  }\n  .z-\\[2147483001\\] {\n    z-index: 2147483001;\n  }\n  .my-2 {\n    margin-block: calc(0.25rem * 2);\n  }\n  .mt-0\\.5 {\n    margin-top: calc(0.25rem * 0.5);\n  }\n  .mt-1 {\n    margin-top: 0.25rem;\n  }\n  .mt-2 {\n    margin-top: calc(0.25rem * 2);\n  }\n  .mt-3 {\n    margin-top: calc(0.25rem * 3);\n  }\n  .mr-2 {\n    margin-right: calc(0.25rem * 2);\n  }\n  .mr-auto {\n    margin-right: auto;\n  }\n  .mb-3 {\n    margin-bottom: calc(0.25rem * 3);\n  }\n  .block {\n    display: block;\n  }\n  .flex {\n    display: flex;\n  }\n  .grid {\n    display: grid;\n  }\n  .hidden {\n    display: none;\n  }\n  .inline-flex {\n    display: inline-flex;\n  }\n  .table {\n    display: table;\n  }\n  .size-4 {\n    width: calc(0.25rem * 4);\n    height: calc(0.25rem * 4);\n  }\n  .size-6 {\n    width: calc(0.25rem * 6);\n    height: calc(0.25rem * 6);\n  }\n  .size-7 {\n    width: calc(0.25rem * 7);\n    height: calc(0.25rem * 7);\n  }\n  .size-12 {\n    width: calc(0.25rem * 12);\n    height: calc(0.25rem * 12);\n  }\n  .size-px {\n    width: 1px;\n    height: 1px;\n  }\n  .h-12 {\n    height: calc(0.25rem * 12);\n  }\n  .h-\\[var\\(--df-height\\)\\] {\n    height: var(--df-height);\n  }\n  .max-h-64 {\n    max-height: calc(0.25rem * 64);\n  }\n  .max-h-72 {\n    max-height: calc(0.25rem * 72);\n  }\n  .max-h-80 {\n    max-height: calc(0.25rem * 80);\n  }\n  .min-h-0 {\n    min-height: 0px;\n  }\n  .min-h-8 {\n    min-height: calc(0.25rem * 8);\n  }\n  .min-h-9 {\n    min-height: calc(0.25rem * 9);\n  }\n  .min-h-10 {\n    min-height: calc(0.25rem * 10);\n  }\n  .min-h-11 {\n    min-height: calc(0.25rem * 11);\n  }\n  .min-h-20 {\n    min-height: calc(0.25rem * 20);\n  }\n  .min-h-28 {\n    min-height: calc(0.25rem * 28);\n  }\n  .min-h-40 {\n    min-height: calc(0.25rem * 40);\n  }\n  .min-h-64 {\n    min-height: calc(0.25rem * 64);\n  }\n  .w-\\[var\\(--df-width\\)\\] {\n    width: var(--df-width);\n  }\n  .w-full {\n    width: 100%;\n  }\n  .max-w-80 {\n    max-width: calc(0.25rem * 80);\n  }\n  .max-w-xl {\n    max-width: 36rem;\n  }\n  .min-w-0 {\n    min-width: 0px;\n  }\n  .min-w-32 {\n    min-width: calc(0.25rem * 32);\n  }\n  .min-w-36 {\n    min-width: calc(0.25rem * 36);\n  }\n  .min-w-40 {\n    min-width: calc(0.25rem * 40);\n  }\n  .flex-1 {\n    flex: 1;\n  }\n  .shrink-0 {\n    flex-shrink: 0;\n  }\n  .cursor-pointer {\n    cursor: pointer;\n  }\n  .cursor-se-resize {\n    cursor: se-resize;\n  }\n  .touch-none {\n    touch-action: none;\n  }\n  .resize {\n    resize: both;\n  }\n  .list-inside {\n    list-style-position: inside;\n  }\n  .list-disc {\n    list-style-type: disc;\n  }\n  .grid-cols-2 {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n  .grid-cols-\\[100px_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: 100px minmax(0,1fr);\n  }\n  .grid-cols-\\[minmax\\(0\\,1\\.4fr\\)_minmax\\(230px\\,1fr\\)\\] {\n    grid-template-columns: minmax(0,1.4fr) minmax(230px,1fr);\n  }\n  .grid-cols-\\[minmax\\(190px\\,28\\%\\)_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: minmax(190px,28%) minmax(0,1fr);\n  }\n  .flex-col {\n    flex-direction: column;\n  }\n  .flex-wrap {\n    flex-wrap: wrap;\n  }\n  .items-center {\n    align-items: center;\n  }\n  .items-start {\n    align-items: flex-start;\n  }\n  .justify-center {\n    justify-content: center;\n  }\n  .gap-1 {\n    gap: 0.25rem;\n  }\n  .gap-2 {\n    gap: calc(0.25rem * 2);\n  }\n  .gap-3 {\n    gap: calc(0.25rem * 3);\n  }\n  .gap-4 {\n    gap: calc(0.25rem * 4);\n  }\n  .space-y-1 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(0.25rem * var(--tw-space-y-reverse));\n      margin-block-end: calc(0.25rem * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-2 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 2) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 2) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-3 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 3) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 3) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-4 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 4) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 4) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .gap-x-4 {\n    column-gap: calc(0.25rem * 4);\n  }\n  .gap-y-1 {\n    row-gap: 0.25rem;\n  }\n  .truncate {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n  }\n  .overflow-auto {\n    overflow: auto;\n  }\n  .overflow-hidden {\n    overflow: hidden;\n  }\n  .overflow-x-auto {\n    overflow-x: auto;\n  }\n  .rounded {\n    border-radius: 0.25rem;\n  }\n  .rounded-full {\n    border-radius: calc(infinity * 1px);\n  }\n  .rounded-lg {\n    border-radius: 0.5rem;\n  }\n  .rounded-md {\n    border-radius: 0.375rem;\n  }\n  .rounded-xl {\n    border-radius: 0.75rem;\n  }\n  .rounded-br-xl {\n    border-bottom-right-radius: 0.75rem;\n  }\n  .border {\n    border-style: var(--tw-border-style);\n    border-width: 1px;\n  }\n  .border-t {\n    border-top-style: var(--tw-border-style);\n    border-top-width: 1px;\n  }\n  .border-b {\n    border-bottom-style: var(--tw-border-style);\n    border-bottom-width: 1px;\n  }\n  .border-b-2 {\n    border-bottom-style: var(--tw-border-style);\n    border-bottom-width: 2px;\n  }\n  .border-dashed {\n    --tw-border-style: dashed;\n    border-style: dashed;\n  }\n  .border-\\[\\#6C4CF5\\] {\n    border-color: #6C4CF5;\n  }\n  .border-\\[\\#7A879B\\] {\n    border-color: #7A879B;\n  }\n  .border-\\[\\#E6EAF3\\] {\n    border-color: #E6EAF3;\n  }\n  .border-transparent {\n    border-color: transparent;\n  }\n  .border-white {\n    border-color: #fff;\n  }\n  .bg-\\[\\#6C4CF5\\] {\n    background-color: #6C4CF5;\n  }\n  .bg-\\[\\#EFEBFF\\] {\n    background-color: #EFEBFF;\n  }\n  .bg-\\[\\#F7F8FC\\] {\n    background-color: #F7F8FC;\n  }\n  .bg-\\[\\#FBFCFE\\] {\n    background-color: #FBFCFE;\n  }\n  .bg-\\[\\#FDF6ED\\] {\n    background-color: #FDF6ED;\n  }\n  .bg-white {\n    background-color: #fff;\n  }\n  .p-2 {\n    padding: calc(0.25rem * 2);\n  }\n  .p-3 {\n    padding: calc(0.25rem * 3);\n  }\n  .p-4 {\n    padding: calc(0.25rem * 4);\n  }\n  .p-6 {\n    padding: calc(0.25rem * 6);\n  }\n  .px-1\\.5 {\n    padding-inline: calc(0.25rem * 1.5);\n  }\n  .px-2 {\n    padding-inline: calc(0.25rem * 2);\n  }\n  .px-3 {\n    padding-inline: calc(0.25rem * 3);\n  }\n  .px-4 {\n    padding-inline: calc(0.25rem * 4);\n  }\n  .py-0\\.5 {\n    padding-block: calc(0.25rem * 0.5);\n  }\n  .py-1 {\n    padding-block: 0.25rem;\n  }\n  .py-1\\.5 {\n    padding-block: calc(0.25rem * 1.5);\n  }\n  .py-2 {\n    padding-block: calc(0.25rem * 2);\n  }\n  .py-3 {\n    padding-block: calc(0.25rem * 3);\n  }\n  .pr-2 {\n    padding-right: calc(0.25rem * 2);\n  }\n  .pr-10 {\n    padding-right: calc(0.25rem * 10);\n  }\n  .pl-\\[var\\(--df-depth\\)\\] {\n    padding-left: var(--df-depth);\n  }\n  .text-center {\n    text-align: center;\n  }\n  .text-left {\n    text-align: left;\n  }\n  .font-mono {\n    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',\n    monospace;\n  }\n  .font-sans {\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial,\n    sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';\n  }\n  .text-lg {\n    font-size: 1.125rem;\n    line-height: var(--tw-leading, calc(1.75 / 1.125));\n  }\n  .text-sm {\n    font-size: 0.875rem;\n    line-height: var(--tw-leading, calc(1.25 / 0.875));\n  }\n  .text-xs {\n    font-size: 0.75rem;\n    line-height: var(--tw-leading, calc(1 / 0.75));\n  }\n  .text-\\[13px\\] {\n    font-size: 13px;\n  }\n  .text-\\[15px\\] {\n    font-size: 15px;\n  }\n  .text-\\[17px\\] {\n    font-size: 17px;\n  }\n  .leading-relaxed {\n    --tw-leading: 1.625;\n    line-height: 1.625;\n  }\n  .font-medium {\n    --tw-font-weight: 500;\n    font-weight: 500;\n  }\n  .font-semibold {\n    --tw-font-weight: 600;\n    font-weight: 600;\n  }\n  .break-all {\n    word-break: break-all;\n  }\n  .whitespace-pre-wrap {\n    white-space: pre-wrap;\n  }\n  .text-\\[\\#6C4CF5\\] {\n    color: #6C4CF5;\n  }\n  .text-\\[\\#8A4D00\\] {\n    color: #8A4D00;\n  }\n  .text-\\[\\#23272E\\] {\n    color: #23272E;\n  }\n  .text-\\[\\#556176\\] {\n    color: #556176;\n  }\n  .text-white {\n    color: #fff;\n  }\n  .accent-\\[\\#6C4CF5\\] {\n    accent-color: #6C4CF5;\n  }\n  .opacity-0 {\n    opacity: 0%;\n  }\n  .shadow-2xl {\n    --tw-shadow: 0 25px 50px -12px var(--tw-shadow-color, rgb(0 0 0 / 0.25));\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n  .shadow-lg {\n    --tw-shadow: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n  .outline-none {\n    --tw-outline-style: none;\n    outline-style: none;\n  }\n  .select-none {\n    -webkit-user-select: none;\n    user-select: none;\n  }\n  .hover\\:bg-\\[\\#5835DA\\] {\n    &:hover {\n      @media (hover: hover) {\n        background-color: #5835DA;\n      }\n    }\n  }\n  .hover\\:bg-\\[\\#F7F8FC\\] {\n    &:hover {\n      @media (hover: hover) {\n        background-color: #F7F8FC;\n      }\n    }\n  }\n  .focus-visible\\:ring-2 {\n    &:focus-visible {\n      --tw-ring-shadow: var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);\n      box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n    }\n  }\n  .focus-visible\\:ring-\\[\\#6C4CF5\\] {\n    &:focus-visible {\n      --tw-ring-color: #6C4CF5;\n    }\n  }\n  .focus-visible\\:ring-offset-2 {\n    &:focus-visible {\n      --tw-ring-offset-width: 2px;\n      --tw-ring-offset-shadow: var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);\n    }\n  }\n  .disabled\\:cursor-not-allowed {\n    &:disabled {\n      cursor: not-allowed;\n    }\n  }\n  .disabled\\:opacity-50 {\n    &:disabled {\n      opacity: 50%;\n    }\n  }\n  .max-\\[700px\\]\\:grid-cols-1 {\n    @media (width < 700px) {\n      grid-template-columns: repeat(1, minmax(0, 1fr));\n    }\n  }\n}\n@property --tw-space-y-reverse {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n@property --tw-border-style {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: solid;\n}\n@property --tw-leading {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-font-weight {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-shadow-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n@property --tw-inset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-inset-shadow-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-inset-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n@property --tw-ring-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-inset-ring-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-inset-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-ring-inset {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-ring-offset-width {\n  syntax: \"<length>\";\n  inherits: false;\n  initial-value: 0px;\n}\n@property --tw-ring-offset-color {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: #fff;\n}\n@property --tw-ring-offset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@layer properties {\n  @supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color:rgb(from red r g b)))) {\n    *, ::before, ::after, ::backdrop {\n      --tw-space-y-reverse: 0;\n      --tw-border-style: solid;\n      --tw-leading: initial;\n      --tw-font-weight: initial;\n      --tw-shadow: 0 0 #0000;\n      --tw-shadow-color: initial;\n      --tw-shadow-alpha: 100%;\n      --tw-inset-shadow: 0 0 #0000;\n      --tw-inset-shadow-color: initial;\n      --tw-inset-shadow-alpha: 100%;\n      --tw-ring-color: initial;\n      --tw-ring-shadow: 0 0 #0000;\n      --tw-inset-ring-color: initial;\n      --tw-inset-ring-shadow: 0 0 #0000;\n      --tw-ring-inset: initial;\n      --tw-ring-offset-width: 0px;\n      --tw-ring-offset-color: #fff;\n      --tw-ring-offset-shadow: 0 0 #0000;\n    }\n  }\n}\n";
//#endregion
//#region ../examples/browser-debugger/src/protocol.ts
function f(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function p(e) {
	return f(e) ? e : {};
}
function m(e) {
	return Array.isArray(e) ? e : [];
}
function h(e, t = "") {
	return typeof e == "string" ? e : t;
}
function g(e, t = 0) {
	return typeof e == "number" && Number.isFinite(e) ? e : t;
}
function _(e, t = 0) {
	if (t > 48) throw Error("JSON 嵌套超过 48 层");
	if (e === null || typeof e == "string" || typeof e == "boolean" || typeof e == "number" && Number.isFinite(e)) return e;
	if (Array.isArray(e)) return e.map((e) => _(e, t + 1));
	if (f(e)) return Object.fromEntries(Object.entries(e).map(([e, n]) => [e, _(n, t + 1)]));
	throw Error("参数必须是有限 JSON");
}
function v(e) {
	if (new TextEncoder().encode(e).length > 131072) throw Error("JSON 输入不能超过 128 KiB");
	return _(JSON.parse(e));
}
var y = class extends Error {
	code;
	logId;
	unconfirmed;
	constructor(e, t, n = null, r = !1) {
		super(e), this.name = "DebuggerFailure", this.code = t, this.logId = n, this.unconfirmed = r;
	}
};
function b(e) {
	if (e instanceof y) return e;
	let t = p(e);
	return new y(e instanceof Error ? e.message : "调试请求失败", h(t.code, "debugger_failed"), h(t.logId) || null, /unconfirmed|timeout|cancel/i.test(h(t.code)));
}
function x(e, t) {
	return new Promise((n, r) => {
		let i = () => r(new y("等待已取消或到期；已派发动作的结果需要核对，不会自动重放", "debugger_wait_unconfirmed", null, !0));
		t.aborted ? (e.catch(() => void 0), i()) : (t.addEventListener("abort", i, { once: !0 }), e.then(n, r).finally(() => t.removeEventListener("abort", i)));
	});
}
var S = (e) => JSON.stringify([
	e.kind,
	e.instanceId,
	e.pluginId,
	e.generation
]);
function C(e) {
	return {
		target_kind: e.kind,
		instance_id: e.instanceId,
		plugin_id: e.pluginId,
		generation: e.generation,
		version: e.version
	};
}
function w(e, t = null) {
	let n = p(e), r = h(n.plugin_id);
	return r ? {
		kind: n.target_kind === "server" ? "server" : "browser",
		instanceId: h(n.instance_id) || t,
		pluginId: r,
		generation: h(n.generation) || null,
		version: h(n.version) || null
	} : null;
}
function T(e) {
	let t = p(e), n = [];
	for (let e of m(t.browser_targets)) {
		let t = w(e);
		t && n.push(t);
	}
	for (let e of m(t.browser_instances)) {
		let t = p(e);
		for (let e of m(t.plugins)) {
			let r = w(e, h(t.instance_id) || null);
			r && n.push(r);
		}
	}
	for (let e of m(t.server_plugins)) {
		let t = p(e), r = h(t.id);
		r && n.push({
			kind: "server",
			instanceId: null,
			pluginId: r,
			generation: h(t.generation) || null,
			version: h(t.version) || null
		});
	}
	return [...new Map(n.map((e) => [S(e), e])).values()];
}
function E(e) {
	let t = p(e);
	if (!h(t.id) || !Array.isArray(t.nodes)) return null;
	let n = [];
	for (let e of t.nodes) {
		let t = p(e);
		if (!h(t.id) || !Number.isSafeInteger(t.generation) || !Number.isSafeInteger(t.revision)) throw Error("UI 节点缺少有效的标识、代次或修订");
		let r = _(t);
		if (!D(r)) throw Error("UI 节点不是对象");
		n.push({
			id: h(t.id),
			generation: g(t.generation),
			revision: g(t.revision),
			parentId: h(t.parentId) || null,
			name: h(t.name),
			role: h(t.role),
			raw: r
		});
	}
	return {
		id: h(t.id),
		observedAt: g(t.observedAt),
		nodes: n,
		raw: _(t)
	};
}
function D(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function O(e) {
	let t = p(e), n = p(t.catalog), r = [];
	for (let e of m(n.commands)) {
		let t = h(p(e).id);
		t && r.push({
			key: `command:${t}`,
			kind: "command",
			id: t,
			version: null,
			schema: null,
			available: !0,
			reason: "公开命令未声明输入模式，请填写 JSON"
		});
	}
	for (let e of [...m(n.services), ...m(t.services)]) {
		let t = p(e), n = p(t.service), i = p(t.contract), a = h(t.id) || h(n.id), o = h(t.version) || h(n.version);
		a && o && r.push({
			key: `service:${a}:${o}`,
			kind: "service",
			id: a,
			version: o,
			schema: _(t.inputSchema ?? i.input_schema ?? i.inputSchema ?? null),
			available: t.available !== !1,
			reason: h(t.reason)
		});
	}
	for (let e of m(t.operations)) {
		let t = p(e), n = h(t.id);
		n && r.push({
			key: `operation:${n}`,
			kind: "operation",
			id: n,
			version: null,
			schema: _(t.input_schema ?? null),
			available: !0,
			reason: "服务器操作沿原任务入口执行，返回原任务 ID"
		});
	}
	return r;
}
function k(e) {
	async function t(t, n, r, i = 15e3) {
		let a = e.extensions;
		if (!a) throw new y("宿主未提供公开扩展服务，请升级宿主", "service_unavailable");
		let o = AbortSignal.any([
			e.signal,
			r,
			AbortSignal.timeout(i)
		]);
		o.throwIfAborted();
		let s = await x(a.callService("host.debugger", "1", {
			action: t,
			...n
		}, o), o);
		return o.throwIfAborted(), s;
	}
	async function n(e, n, r, i = 15e3) {
		let a = await t("call", {
			name: `deviceforge.debug_${e}`,
			input: n
		}, r, i), o = p(a.data);
		if (typeof o.state == "string" && o.state.endsWith("_unconfirmed")) throw new y(h(p(p(o.response).error).message, "命令等待结束，真实结果未确认；请查询目标状态，不会自动重试"), h(p(p(o.response).error).code, o.state), a.logId, !0);
		if (typeof o.command_id == "string") {
			let e = h(o.state);
			if (e !== "succeeded") {
				let t = p(p(o.response).error);
				throw new y(h(t.message, `命令状态：${e || "未知"}；没有确认成功，不会自动重试`), h(t.code, e || "result_unconfirmed"), a.logId, e !== "failed");
			}
			if (o.response === void 0) throw new y("成功回执缺少 response", "invalid_receipt", a.logId);
			return {
				data: _(o.response),
				logId: a.logId
			};
		}
		return a;
	}
	return {
		service: t,
		call: n
	};
}
//#endregion
//#region ../examples/browser-debugger/src/tree-utils.ts
function A(e, t) {
	let n = new Map(t.map((e) => [e.id, e])), r = /* @__PURE__ */ new Set([e.id]), i = e.parentId, a = 0;
	for (; i && a < 32 && !r.has(i);) r.add(i), a++, i = n.get(i)?.parentId ?? null;
	return a;
}
function j(e, t, n, r) {
	let i = new Map(e.map((e) => [e.id, e])), a = e.filter((e) => (!t.name || `${e.name} ${e.id}`.toLocaleLowerCase().includes(t.name.toLocaleLowerCase())) && (!t.role || e.role === t.role) && (!t.hidden || h(e.raw.hidden) === t.hidden) && (!t.disabled || h(e.raw.disabled) === t.disabled) && (!r || r.includes(e.id))), o = !!(t.name || t.role || t.hidden || t.disabled || r), s = new Set(a.map((e) => e.id));
	if (o) for (let e of a) {
		let t = e.parentId, n = /* @__PURE__ */ new Set();
		for (; t && !n.has(t);) n.add(t), s.add(t), t = i.get(t)?.parentId ?? null;
	}
	return e.filter((e) => {
		if (!s.has(e.id)) return !1;
		if (o) return !0;
		let t = e.parentId, r = /* @__PURE__ */ new Set();
		for (; t && !r.has(t);) {
			if (n.has(t)) return !1;
			r.add(t), t = i.get(t)?.parentId ?? null;
		}
		return !0;
	});
}
//#endregion
//#region ../examples/browser-debugger/src/ui.tsx
var M = "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50";
function N({ children: e, primary: t = !1, ...n }) {
	return /* @__PURE__ */ r("button", {
		type: "button",
		...n,
		className: `${t ? "border-[#6C4CF5] bg-[#6C4CF5] text-white hover:bg-[#5835DA]" : "border-[#E6EAF3] bg-white text-[#23272E] hover:bg-[#F7F8FC]"} min-h-8 shrink-0 rounded-md border px-3 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 ${n.className ?? ""}`,
		children: e
	});
}
function P({ children: e, warning: t = !1 }) {
	return /* @__PURE__ */ r("span", {
		className: `${t ? "bg-[#FDF6ED] text-[#8A4D00]" : "bg-[#EFEBFF] text-[#6C4CF5]"} inline-flex rounded px-1.5 py-0.5 text-xs`,
		children: e
	});
}
function F({ checked: e, onChange: t, children: n, disabled: a = !1 }) {
	return /* @__PURE__ */ i("label", {
		className: "flex cursor-pointer items-start gap-2 text-[13px] text-[#556176]",
		children: [/* @__PURE__ */ r("input", {
			type: "checkbox",
			className: "mt-0.5 size-4 accent-[#6C4CF5] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
			checked: e,
			disabled: a,
			onChange: (e) => t(e.currentTarget.checked)
		}), n]
	});
}
function I({ value: e, label: t = "查看辅助 JSON" }) {
	return /* @__PURE__ */ i("details", {
		className: "min-w-0 rounded-lg border border-[#E6EAF3] bg-[#FBFCFE] text-[13px]",
		children: [/* @__PURE__ */ r("summary", {
			className: "cursor-pointer px-3 py-2 text-[#556176] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
			children: t
		}), /* @__PURE__ */ r("pre", {
			className: "max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-[#E6EAF3] p-3 text-xs text-[#23272E]",
			children: JSON.stringify(e, null, 2)
		})]
	});
}
function L({ title: e, children: t }) {
	return /* @__PURE__ */ i("div", {
		className: "flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#E6EAF3] p-6 text-center",
		children: [/* @__PURE__ */ r("p", {
			className: "text-sm font-medium text-[#23272E]",
			children: e
		}), /* @__PURE__ */ r("div", {
			className: "max-w-xl text-[13px] leading-relaxed text-[#556176]",
			children: t
		})]
	});
}
function R({ label: e, children: t }) {
	return /* @__PURE__ */ i("div", {
		className: "grid min-w-0 grid-cols-[100px_minmax(0,1fr)] gap-2 border-b border-[#E6EAF3] py-2 text-[13px]",
		children: [/* @__PURE__ */ r("dt", {
			className: "text-[#556176]",
			children: e
		}), /* @__PURE__ */ r("dd", {
			className: "min-w-0 break-all text-[#23272E]",
			children: t
		})]
	});
}
async function z(e, t) {
	if (t.defaultView?.navigator.clipboard?.writeText) {
		await t.defaultView.navigator.clipboard.writeText(e);
		return;
	}
	let n = t.activeElement, r = t.createElement("textarea");
	r.value = e, r.className = "fixed left-0 top-0 size-px opacity-0", r.setAttribute("aria-label", "复制日志 ID"), t.body.append(r), r.select();
	try {
		if (!t.execCommand("copy")) throw Error("复制不可用，请选择并手动复制日志 ID");
	} finally {
		r.remove(), n instanceof HTMLElement && n.focus();
	}
}
function B({ value: t, label: n = "复制日志 ID" }) {
	let [a, o] = e.useState(""), s = e.useRef(null);
	return t ? /* @__PURE__ */ i("span", {
		ref: s,
		className: "inline-flex min-w-0 flex-wrap items-center gap-2",
		children: [
			/* @__PURE__ */ r("code", {
				className: "break-all text-xs",
				title: t,
				children: t
			}),
			/* @__PURE__ */ r(N, {
				onClick: () => {
					let e = s.current?.ownerDocument;
					e && z(t, e).then(() => o("已复制"), (e) => o(e instanceof Error ? e.message : "复制失败"));
				},
				children: n
			}),
			/* @__PURE__ */ r("span", {
				role: "status",
				className: "text-xs text-[#556176]",
				children: a
			})
		]
	}) : /* @__PURE__ */ r("span", {
		className: "text-xs text-[#556176]",
		children: "未提供日志 ID"
	});
}
function V({ value: e }) {
	if (e === null) return null;
	let t = p(e), a = p(t.result_metadata), o = p(t.artifact), s = h(t.status) || h(t.state), c = p(t.host), l = p(t.owner);
	return /* @__PURE__ */ i("section", {
		"aria-label": "最近操作结果",
		className: "space-y-3 rounded-lg border border-[#E6EAF3] bg-[#FBFCFE] p-3",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ r("h3", {
					className: "text-sm font-medium",
					children: "最近操作结果"
				}), s && /* @__PURE__ */ r(P, {
					warning: /failed|rejected|indeterminate|unconfirmed/.test(s),
					children: s
				})]
			}),
			h(t.reason) && /* @__PURE__ */ r("p", {
				className: "text-[13px] text-[#556176]",
				children: h(t.reason)
			}),
			t.source === "host-dom" && /* @__PURE__ */ i(n, { children: [
				/* @__PURE__ */ r("h4", {
					className: "text-sm font-medium",
					children: "宿主节点 · 只读身份"
				}),
				/* @__PURE__ */ i("dl", { children: [
					/* @__PURE__ */ r(R, {
						label: "名称",
						children: h(c.label, "未提供")
					}),
					/* @__PURE__ */ i(R, {
						label: "标签 / 角色",
						children: [
							h(c.tag),
							" · ",
							h(c.role, "未提供")
						]
					}),
					/* @__PURE__ */ r(R, {
						label: "插入能力",
						children: "此普通节点不可插入"
					}),
					/* @__PURE__ */ r(R, {
						label: "最近公开槽位",
						children: typeof c.nearest_slot == "string" ? c.nearest_slot : h(p(c.nearest_slot).id, "未观测到真实公开祖先槽位")
					}),
					/* @__PURE__ */ r(R, {
						label: "所在路由",
						children: typeof c.route == "string" ? c.route : h(p(c.route).path, "未提供")
					})
				] }),
				/* @__PURE__ */ r("p", {
					className: "text-[13px] text-[#556176]",
					children: "该身份没有插件节点引用，不能点击、填值或作为插件动作目标。"
				})
			] }),
			h(l.pluginId) && /* @__PURE__ */ i("p", {
				className: "break-all text-[13px]",
				children: [
					"拾取归属：",
					/* @__PURE__ */ r("code", { children: h(l.pluginId) }),
					" · 代次 ",
					/* @__PURE__ */ r("code", { children: String(l.generation ?? "未提供") })
				]
			}),
			typeof t.matched == "number" && /* @__PURE__ */ i("p", {
				className: "text-sm",
				children: [
					"命中 ",
					t.matched,
					" 个节点"
				]
			}),
			[
				"added",
				"removed",
				"changed"
			].some((e) => Array.isArray(t[e])) && /* @__PURE__ */ i("div", {
				className: "flex gap-4 text-sm",
				children: [
					/* @__PURE__ */ i("span", { children: ["新增 ", m(t.added).length] }),
					/* @__PURE__ */ i("span", { children: ["移除 ", m(t.removed).length] }),
					/* @__PURE__ */ i("span", { children: ["变更 ", m(t.changed).length] })
				]
			}),
			h(t.job_id) && /* @__PURE__ */ i("dl", { children: [/* @__PURE__ */ r(R, {
				label: "原任务 ID",
				children: /* @__PURE__ */ r("code", { children: h(t.job_id) })
			}), /* @__PURE__ */ r(R, {
				label: "任务状态",
				children: h(t.status, "请沿原任务入口查询")
			})] }),
			a.included === !1 && /* @__PURE__ */ i("p", {
				className: "text-[13px] text-[#556176]",
				children: [
					"结果正文未收集：",
					h(a.type),
					"，",
					String(a.bytes ?? "未知"),
					" 字节。"
				]
			}),
			t.businessOutcome === "unknown" && /* @__PURE__ */ r("p", {
				className: "text-[13px] text-[#8A4D00]",
				children: "业务结果未知；合成事件派发不代表设备或业务操作成功。"
			}),
			h(o.id) && /* @__PURE__ */ i("p", {
				className: "text-[13px]",
				children: ["报告产物：", /* @__PURE__ */ r("code", { children: h(o.id) })]
			}),
			/* @__PURE__ */ r(I, { value: e })
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/tree-view.tsx
var H = (e) => e === "yes" ? "是" : e === "no" ? "否" : "未知";
function U({ state: t, controller: a }) {
	let [o, s] = e.useState(""), [c, l] = e.useState(""), [u, d] = e.useState(""), [f, g] = e.useState(""), [_, y] = e.useState(/* @__PURE__ */ new Set()), [b, x] = e.useState(!1), [S, C] = e.useState(!1), [w, T] = e.useState(""), [E, D] = e.useState("click"), [O, k] = e.useState("{\"query\":{\"role\":\"button\"},\"condition\":\"exists\"}"), [z, B] = e.useState(""), [U, ee] = e.useState(""), [W, G] = e.useState(""), K = t.tree?.nodes ?? [], q = j(K, {
		name: o,
		role: c,
		hidden: u,
		disabled: f
	}, _, t.queries), J = K.find((e) => e.id === t.selectedNodeId), Y = t.stale || !t.connected || !t.sessionId || !!t.busy, X = p(p(t.inspection).capabilities);
	e.useEffect(() => {
		x(!1), C(!1), T("");
	}, [
		t.selectedNodeId,
		t.rootId,
		t.sessionId
	]);
	function te(e) {
		y((t) => {
			let n = new Set(t);
			return n.has(e.id) ? n.delete(e.id) : n.add(e.id), n;
		});
	}
	function ne(e, t) {
		try {
			let n = v(e);
			G(""), t(n);
		} catch (e) {
			G(e instanceof Error ? e.message : "JSON 无效");
		}
	}
	let Z = p(p(t.tree?.raw).page), Q = p(p(t.tree?.raw).coverage);
	return /* @__PURE__ */ i("div", {
		className: "flex min-h-0 flex-1 flex-col gap-3",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					/* @__PURE__ */ i("label", {
						className: "flex min-w-0 items-center gap-2 text-[13px]",
						children: ["挂载根", /* @__PURE__ */ i("select", {
							"aria-label": "挂载根",
							className: M,
							value: t.rootId,
							disabled: t.stale || !!t.busy,
							onChange: (e) => a.setRoot(e.currentTarget.value),
							children: [/* @__PURE__ */ r("option", {
								value: "",
								children: t.roots.length > 1 ? "请明确选择挂载根" : "暂无挂载根"
							}), t.roots.map((e) => /* @__PURE__ */ i("option", {
								value: e.id,
								children: [
									e.label || e.id,
									" · ",
									e.id
								]
							}, e.id))]
						})]
					}),
					/* @__PURE__ */ r(N, {
						disabled: Y || t.roots.length > 1 && !t.rootId,
						onClick: () => void a.tree(),
						children: "读取新快照"
					}),
					/* @__PURE__ */ r(N, {
						disabled: Y || X.pick === !1,
						title: X.pick === !1 ? "宿主未提供公开拾取能力" : "点击插件节点；Esc 取消",
						onClick: () => void a.action("pick", null, "", !1, !1),
						children: "拾取节点"
					}),
					/* @__PURE__ */ r(N, {
						disabled: Y,
						onClick: () => void a.overview(),
						children: "公开槽位与路由"
					}),
					t.tree && /* @__PURE__ */ r(P, {
						warning: t.stale,
						children: t.stale ? "已过期 · 只读" : "只读观测快照"
					})
				]
			}),
			/* @__PURE__ */ r("p", {
				className: "rounded-md bg-[#F7F8FC] px-3 py-2 text-[13px] text-[#556176]",
				children: "可观测节点不等于公开插入槽位。隐藏、遮挡和虚拟内容可能未知；不完整采集不能证明节点不存在。"
			}),
			t.target?.kind === "server" ? /* @__PURE__ */ r(L, {
				title: "服务器目标不提供浏览器 UI 树",
				children: "可以检查公开服务、查询事件和服务器日志，试调用仍沿原任务执行。"
			}) : t.tree ? /* @__PURE__ */ i("div", {
				className: "grid min-h-64 flex-1 grid-cols-[minmax(190px,28%)_minmax(0,1fr)] gap-4 max-[700px]:grid-cols-1",
				children: [/* @__PURE__ */ i("section", {
					"aria-label": "UI 结构树",
					className: "flex min-h-0 flex-col rounded-lg border border-[#E6EAF3]",
					children: [
						/* @__PURE__ */ i("div", {
							className: "space-y-2 border-b border-[#E6EAF3] p-3",
							children: [
								/* @__PURE__ */ r("input", {
									className: `${M} w-full`,
									placeholder: "搜索名称或节点 ID",
									"aria-label": "搜索节点",
									value: o,
									onChange: (e) => s(e.currentTarget.value)
								}),
								/* @__PURE__ */ i("div", {
									className: "grid grid-cols-2 gap-2",
									children: [/* @__PURE__ */ i("select", {
										"aria-label": "语义角色",
										className: M,
										value: c,
										onChange: (e) => l(e.currentTarget.value),
										children: [/* @__PURE__ */ r("option", {
											value: "",
											children: "全部角色"
										}), [...new Set(K.map((e) => e.role))].filter(Boolean).map((e) => /* @__PURE__ */ r("option", { children: e }, e))]
									}), /* @__PURE__ */ i("select", {
										"aria-label": "隐藏状态",
										className: M,
										value: u,
										onChange: (e) => d(e.currentTarget.value),
										children: [
											/* @__PURE__ */ r("option", {
												value: "",
												children: "全部隐藏状态"
											}),
											/* @__PURE__ */ r("option", {
												value: "yes",
												children: "已隐藏"
											}),
											/* @__PURE__ */ r("option", {
												value: "no",
												children: "未隐藏"
											}),
											/* @__PURE__ */ r("option", {
												value: "unknown",
												children: "隐藏未知"
											})
										]
									})]
								}),
								/* @__PURE__ */ i("select", {
									"aria-label": "禁用状态",
									className: `${M} w-full`,
									value: f,
									onChange: (e) => g(e.currentTarget.value),
									children: [
										/* @__PURE__ */ r("option", {
											value: "",
											children: "全部禁用状态"
										}),
										/* @__PURE__ */ r("option", {
											value: "yes",
											children: "已禁用"
										}),
										/* @__PURE__ */ r("option", {
											value: "no",
											children: "未禁用"
										}),
										/* @__PURE__ */ r("option", {
											value: "unknown",
											children: "禁用未知"
										})
									]
								}),
								/* @__PURE__ */ i("div", {
									className: "flex flex-wrap gap-2",
									children: [/* @__PURE__ */ r(N, {
										disabled: Y,
										onClick: () => void a.query({
											...o ? { name: o } : {},
											...c ? { role: c } : {},
											...u ? { hidden: u } : {},
											...f ? { disabled: f } : {},
											limit: 500
										}),
										children: "按语义查询"
									}), t.queries && /* @__PURE__ */ r(N, {
										onClick: () => a.clearQuery(),
										children: "清除查询"
									})]
								})
							]
						}),
						/* @__PURE__ */ i("ul", {
							role: "tree",
							"aria-label": "已观测节点",
							className: "min-h-0 flex-1 overflow-auto p-2",
							children: [q.map((e, n) => {
								let o = K.some((t) => t.parentId === e.id), s = { "--df-depth": `${8 + A(e, K) * 14}px` };
								return /* @__PURE__ */ i("li", {
									role: "none",
									className: "flex items-center",
									children: [o && /* @__PURE__ */ r("button", {
										type: "button",
										"aria-label": `${_.has(e.id) ? "展开" : "折叠"} ${e.name || e.role}`,
										className: "size-6 shrink-0 rounded text-[#556176] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
										onClick: () => te(e),
										children: _.has(e.id) ? "▸" : "▾"
									}), /* @__PURE__ */ i("button", {
										type: "button",
										role: "treeitem",
										"aria-selected": e.id === t.selectedNodeId,
										"aria-level": A(e, K) + 1,
										"aria-expanded": o ? !_.has(e.id) : void 0,
										style: s,
										className: `${e.id === t.selectedNodeId ? "bg-[#EFEBFF] text-[#6C4CF5]" : "text-[#23272E] hover:bg-[#F7F8FC]"} min-h-9 min-w-0 flex-1 rounded py-2 pr-2 pl-[var(--df-depth)] text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`,
										title: `${e.role} · ${e.name}\n${e.id}`,
										onClick: () => a.setNode(e.id),
										onKeyDown: (t) => {
											let r = t.key === "ArrowDown" ? 1 : t.key === "ArrowUp" ? -1 : 0, i = q[n + r];
											r && i && (t.preventDefault(), a.setNode(i.id), (t.currentTarget.closest("[role=tree]")?.querySelectorAll("[role=treeitem]"))?.[n + r]?.focus()), (t.key === "ArrowLeft" || t.key === "ArrowRight") && o && (t.preventDefault(), y((n) => {
												let r = new Set(n);
												return t.key === "ArrowLeft" ? r.add(e.id) : r.delete(e.id), r;
											}));
										},
										children: [/* @__PURE__ */ r("span", {
											className: "block truncate font-medium",
											children: e.name || e.role || e.raw.tag?.toString() || "未命名节点"
										}), /* @__PURE__ */ i("span", {
											className: "block truncate text-xs text-[#556176]",
											children: [
												e.role,
												" · ",
												e.id
											]
										})]
									})]
								}, e.id);
							}), !q.length && /* @__PURE__ */ r("li", {
								className: "p-3 text-[13px] text-[#556176]",
								children: "当前页没有匹配节点。"
							})]
						}),
						/* @__PURE__ */ i("div", {
							className: "border-t border-[#E6EAF3] p-2 text-xs text-[#556176]",
							children: [
								"已加载 ",
								K.length,
								" / ",
								typeof Z.total == "number" ? Z.total : K.length,
								" 节点",
								typeof Z.nextOffset == "number" && /* @__PURE__ */ r(N, {
									disabled: Y,
									onClick: () => void a.nextTreePage(),
									children: "加载下一页"
								})
							]
						})
					]
				}), /* @__PURE__ */ i("section", {
					"aria-label": "节点详情",
					className: "min-h-0 space-y-3 overflow-auto rounded-lg border border-[#E6EAF3] p-4",
					children: [J ? /* @__PURE__ */ i(n, { children: [
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [
								/* @__PURE__ */ r("h3", {
									className: "text-[15px] font-semibold",
									children: J.name || J.role
								}),
								/* @__PURE__ */ r(P, { children: h(J.raw.kind, "节点") }),
								t.stale && /* @__PURE__ */ r(P, {
									warning: !0,
									children: "当时观测 · 已过期"
								})
							]
						}),
						/* @__PURE__ */ i("dl", { children: [
							/* @__PURE__ */ r(R, {
								label: "节点 ID",
								children: /* @__PURE__ */ r("code", { children: J.id })
							}),
							/* @__PURE__ */ r(R, {
								label: "节点引用",
								children: /* @__PURE__ */ i("code", { children: [
									"g",
									J.generation,
									" / r",
									J.revision
								] })
							}),
							/* @__PURE__ */ r(R, {
								label: "所属表面",
								children: /* @__PURE__ */ r("code", { children: h(J.raw.surfaceId, "未提供") })
							}),
							/* @__PURE__ */ r(R, {
								label: "语义角色",
								children: J.role || "未提供"
							}),
							/* @__PURE__ */ i(R, {
								label: "状态证据",
								children: [
									"隐藏 ",
									H(J.raw.hidden),
									" · 禁用 ",
									H(J.raw.disabled),
									" · 可见 ",
									H(J.raw.visible)
								]
							}),
							/* @__PURE__ */ i(R, {
								label: "动作约束",
								children: [
									h(J.raw.actionPolicy, "unknown"),
									" · ",
									J.raw.confirmationRequired ? "需要原操作确认" : "仍需本次显式动作"
								]
							}),
							/* @__PURE__ */ r(R, {
								label: "插入能力",
								children: "仅公开槽位可接入；此节点不授予插入权限"
							})
						] }),
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap gap-2",
							children: [/* @__PURE__ */ r(N, {
								disabled: Y,
								onClick: () => void a.action("highlight", J, "", !1, !1),
								children: "临时高亮"
							}), /* @__PURE__ */ r(P, {
								warning: J.raw.opaque === !0,
								children: J.raw.opaque ? "不透明内容" : "仅观测 DOM"
							})]
						}),
						/* @__PURE__ */ i("div", {
							className: "space-y-3 rounded-md bg-[#F7F8FC] p-3",
							children: [
								/* @__PURE__ */ r("h4", {
									className: "text-sm font-medium",
									children: "显式节点动作"
								}),
								/* @__PURE__ */ i("select", {
									"aria-label": "节点动作类型",
									className: M,
									value: E,
									onChange: (e) => {
										D(e.currentTarget.value), x(!1), C(!1);
									},
									children: [
										/* @__PURE__ */ r("option", {
											value: "click",
											children: "点击"
										}),
										/* @__PURE__ */ r("option", {
											value: "fill",
											children: "填值"
										}),
										/* @__PURE__ */ r("option", {
											value: "select",
											children: "选择选项"
										}),
										/* @__PURE__ */ r("option", {
											value: "scroll",
											children: "滚动至节点"
										})
									]
								}),
								(E === "fill" || E === "select") && /* @__PURE__ */ r("textarea", {
									"aria-label": E === "select" ? "选项值，每行一项" : "填充值",
									className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 min-h-20 w-full",
									value: w,
									onChange: (e) => {
										T(e.currentTarget.value), x(!1), C(!1);
									},
									placeholder: E === "select" ? "每行一个选项值" : "原生输入框的新值"
								}),
								/* @__PURE__ */ r(F, {
									disabled: t.stale,
									checked: b,
									onChange: x,
									children: "确认对此节点执行本次动作"
								}),
								/* @__PURE__ */ r(F, {
									disabled: t.stale,
									checked: S,
									onChange: C,
									children: "允许未知副作用，可能间接影响设备或外部资源"
								}),
								/* @__PURE__ */ r(N, {
									disabled: Y || !b || !S,
									primary: !0,
									onClick: () => {
										a.action(E, J, w, b, S), x(!1), C(!1);
									},
									children: "执行一次"
								})
							]
						}),
						/* @__PURE__ */ r(I, {
							value: J.raw.layout ?? null,
							label: "布局与裁切证据"
						}),
						/* @__PURE__ */ r(I, {
							value: J.raw,
							label: "节点属性与元数据"
						})
					] }) : p(t.result).source === "host-dom" ? /* @__PURE__ */ r(V, { value: t.result }) : /* @__PURE__ */ r(L, {
						title: "选择左侧节点查看详情",
						children: "节点标识与修订绑定当前快照；读取新快照后动作仍由宿主核验。"
					}), /* @__PURE__ */ i("p", {
						className: "text-xs text-[#556176]",
						children: [
							"快照 ",
							/* @__PURE__ */ r("code", { children: t.tree.id }),
							" · ",
							new Date(t.tree.observedAt).toLocaleString(),
							" · 覆盖 ",
							h(Q.completeness, "未知"),
							m(Q.truncation).length ? " · 已截断" : ""
						]
					})]
				})]
			}) : /* @__PURE__ */ r(L, {
				title: t.roots.length ? "尚未读取此挂载根的快照" : "目标未提供已实例化的挂载根",
				children: t.roots.length > 1 ? "选择一个挂载根，再读取结构树。" : "未打开页面不会生成 UI 树。可以查询公开目录或在原业务入口打开页面后刷新检查。"
			}),
			t.target?.kind === "browser" && /* @__PURE__ */ i("details", {
				className: "rounded-lg border border-[#E6EAF3] p-3 text-[13px]",
				children: [
					/* @__PURE__ */ r("summary", {
						className: "cursor-pointer font-medium",
						children: "快照差异与结构断言"
					}),
					/* @__PURE__ */ i("div", {
						className: "mt-3 flex flex-wrap items-center gap-2",
						children: [
							/* @__PURE__ */ i("label", { children: ["差异前 ", /* @__PURE__ */ i("select", {
								"aria-label": "差异前快照",
								className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50",
								value: z,
								onChange: (e) => B(e.currentTarget.value),
								children: [/* @__PURE__ */ r("option", {
									value: "",
									children: "选择快照"
								}), t.trees.map((e) => /* @__PURE__ */ r("option", { children: e.id }, e.id))]
							})] }),
							/* @__PURE__ */ i("label", { children: ["差异后 ", /* @__PURE__ */ i("select", {
								"aria-label": "差异后快照",
								className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50",
								value: U,
								onChange: (e) => ee(e.currentTarget.value),
								children: [/* @__PURE__ */ r("option", {
									value: "",
									children: "选择快照"
								}), t.trees.map((e) => /* @__PURE__ */ r("option", { children: e.id }, e.id))]
							})] }),
							/* @__PURE__ */ r(N, {
								disabled: Y || !z || !U || z === U,
								onClick: () => void a.diff(z, U),
								children: "比较差异"
							})
						]
					}),
					/* @__PURE__ */ i("label", {
						className: "mt-3 block text-[#556176]",
						children: ["断言 JSON", /* @__PURE__ */ r("textarea", {
							"aria-label": "结构断言 JSON",
							className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 mt-1 min-h-20 w-full font-mono",
							value: O,
							onChange: (e) => k(e.currentTarget.value)
						})]
					}),
					/* @__PURE__ */ r("p", {
						className: "my-2 text-xs text-[#556176]",
						children: "支持 exists / absent / count / enabled / visible / valid 及布局条件；布局证据不足时返回无法判定。"
					}),
					W && /* @__PURE__ */ r("p", {
						role: "alert",
						className: "text-[#8A4D00]",
						children: W
					}),
					/* @__PURE__ */ r(N, {
						disabled: Y || !t.rootId,
						onClick: () => ne(O, a.assertion),
						children: "执行断言"
					})
				]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/targets-view.tsx
function ee({ state: t, controller: a }) {
	let [o, s] = e.useState("browser"), [c, l] = e.useState(t.instanceId ?? ""), [u, d] = e.useState("");
	e.useEffect(() => {
		t.instanceId && l(t.instanceId);
	}, [t.instanceId]);
	let f = t.requested, h = t.targets.filter((e) => f ? f.candidates.some((t) => t.kind === e.kind && t.pluginId === e.pluginId) : e.kind === o && (o === "server" || e.instanceId === c)).filter((e) => e.pluginId.toLocaleLowerCase().includes(u.toLocaleLowerCase()));
	return /* @__PURE__ */ i("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ r("h2", {
					className: "mr-auto text-[15px] font-semibold",
					children: "明确选择调试目标"
				}), /* @__PURE__ */ r(N, {
					disabled: !!t.busy,
					onClick: () => void a.refreshTargets(),
					children: "刷新目录"
				})]
			}),
			f && /* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2 rounded-md bg-[#EFEBFF] p-3 text-[13px] text-[#6C4CF5]",
				children: [/* @__PURE__ */ i("span", { children: [
					"市场带入 ",
					f.candidates.length,
					" 个候选组件",
					f.installationId ? ` · 安装 ${f.installationId}` : "",
					"，请明确选择组件和实例。"
				] }), /* @__PURE__ */ r(N, {
					onClick: () => a.clearRequested(),
					children: "显示全部目标"
				})]
			}),
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap gap-3",
				children: [!f && /* @__PURE__ */ i(n, { children: [/* @__PURE__ */ i("label", {
					className: "text-[13px]",
					children: ["目标类型 ", /* @__PURE__ */ i("select", {
						"aria-label": "目标类型",
						className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50",
						value: o,
						onChange: (e) => s(e.currentTarget.value),
						children: [/* @__PURE__ */ r("option", {
							value: "browser",
							children: "浏览器插件"
						}), /* @__PURE__ */ r("option", {
							value: "server",
							children: "服务器插件"
						})]
					})]
				}), o === "browser" && /* @__PURE__ */ i("label", {
					className: "min-w-0 text-[13px]",
					children: ["浏览器实例 ", /* @__PURE__ */ i("select", {
						"aria-label": "浏览器实例",
						className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 max-w-80",
						value: c,
						onChange: (e) => l(e.currentTarget.value),
						children: [/* @__PURE__ */ r("option", {
							value: "",
							children: "请选择实例"
						}), [...new Set(t.targets.filter((e) => e.kind === "browser").map((e) => e.instanceId))].filter(Boolean).map((e) => /* @__PURE__ */ i("option", {
							value: e ?? "",
							children: [e === t.instanceId ? "当前实例 · " : "其他实例 · ", e]
						}, e))]
					})]
				})] }), /* @__PURE__ */ r("input", {
					"aria-label": "筛选插件 ID",
					className: `${M} min-w-36 flex-1`,
					value: u,
					onChange: (e) => d(e.currentTarget.value),
					placeholder: "筛选插件 ID"
				})]
			}),
			h.length ? /* @__PURE__ */ r("div", {
				className: "grid grid-cols-2 gap-3 max-[700px]:grid-cols-1",
				children: h.map((e) => /* @__PURE__ */ i("article", {
					className: `${t.target && S(t.target) === S(e) ? "border-[#6C4CF5] bg-[#EFEBFF]" : "border-[#E6EAF3] bg-white"} min-w-0 space-y-2 rounded-lg border p-4`,
					children: [
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [/* @__PURE__ */ r("h3", {
								className: "min-w-0 flex-1 break-all text-sm font-semibold",
								children: e.pluginId
							}), /* @__PURE__ */ r(P, { children: e.kind === "browser" ? "浏览器" : "服务器" })]
						}),
						/* @__PURE__ */ i("p", {
							className: "break-all text-xs text-[#556176]",
							children: [
								e.instanceId === t.instanceId ? "当前实例" : e.instanceId || "服务器宿主",
								" · ",
								e.version || "版本未提供"
							]
						}),
						/* @__PURE__ */ r("p", {
							className: "text-[13px] text-[#556176]",
							children: e.generation ? /* @__PURE__ */ i(n, { children: ["代次 ", /* @__PURE__ */ r("code", { children: e.generation })] }) : "代次未提供 · 选择后查询实际支持能力"
						}),
						/* @__PURE__ */ r(N, {
							disabled: !!t.busy,
							primary: !0,
							onClick: () => void a.select(e),
							children: e.kind === "server" ? "选择并检查公开服务" : "选择并检查此插件"
						})
					]
				}, S(e)))
			}) : /* @__PURE__ */ r(L, {
				title: f ? "候选组件尚未出现在运行目录" : "尚无可调试目标",
				children: "请在原市场入口启用组件，或确认选定实例在线后刷新目录。安装存在不代表此浏览器已经启用。"
			}),
			t.target && /* @__PURE__ */ i("section", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("h3", {
						className: "text-sm font-semibold",
						children: "当前目标能力与证据"
					}),
					/* @__PURE__ */ i("dl", { children: [
						/* @__PURE__ */ r(R, {
							label: "选定插件",
							children: /* @__PURE__ */ r("code", { children: t.target.pluginId })
						}),
						/* @__PURE__ */ r(R, {
							label: "完整实例",
							children: /* @__PURE__ */ r("code", { children: t.target.instanceId || "服务器目标" })
						}),
						/* @__PURE__ */ r(R, {
							label: "代次",
							children: /* @__PURE__ */ r("code", { children: t.target.generation || "未提供" })
						})
					] }),
					/* @__PURE__ */ r("div", {
						className: "flex flex-wrap gap-2",
						children: Object.entries(p(p(t.inspection).capabilities)).filter(([, e]) => typeof e == "boolean").map(([e, t]) => /* @__PURE__ */ i(P, {
							warning: !t,
							children: [
								e,
								"：",
								t ? "支持" : "未提供"
							]
						}, e))
					}),
					m(p(t.inspection).cleanup_history).length > 0 && /* @__PURE__ */ i("div", {
						className: "rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
						children: ["旧代清理失败保留供诊断，不阻止独立新调用。", /* @__PURE__ */ r(I, {
							value: p(t.inspection).cleanup_history,
							label: "查看历史清理告警"
						})]
					}),
					/* @__PURE__ */ r(I, {
						value: t.inspection,
						label: "检查详情、登记资源与生命周期"
					})
				]
			})
		]
	});
}
function W({ state: e, controller: t }) {
	let n = p(e.overview), a = p(n.page), o = m(p(e.inspection).slot_catalog), s = m(p(e.inspection).mount_catalog), c = m(n.nodes).length ? m(n.nodes) : [...o.map((e) => ({
		kind: "slot",
		catalog: e
	})), ...s.map((e) => ({
		kind: "mount",
		catalog: e
	}))];
	return /* @__PURE__ */ i("section", {
		className: "space-y-3",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ r("h2", {
					className: "mr-auto text-[15px] font-semibold",
					children: "公开槽位、路由与挂载目录"
				}), /* @__PURE__ */ r(N, {
					disabled: !e.sessionId || e.stale || !!e.busy,
					onClick: () => void t.overview(),
					children: "读取目录"
				})]
			}),
			/* @__PURE__ */ r("p", {
				className: "rounded-md bg-[#F7F8FC] p-3 text-[13px] text-[#556176]",
				children: "目录证据 catalog-only。槽位可用于公开贡献；路由仅作宿主明确允许的导航；未实例化条目不推导 DOM。"
			}),
			c.length ? /* @__PURE__ */ r("div", {
				className: "space-y-2",
				children: c.map((n, a) => {
					let o = p(n), s = p(o.catalog), c = h(s.id) || h(s.path) || h(s.contribution_id) || `条目 ${a + 1}`;
					return /* @__PURE__ */ i("article", {
						className: "rounded-lg border border-[#E6EAF3] p-3",
						children: [
							/* @__PURE__ */ i("div", {
								className: "flex flex-wrap items-center gap-2",
								children: [/* @__PURE__ */ r(P, { children: h(o.kind, "目录") }), /* @__PURE__ */ r("strong", {
									className: "break-all text-sm",
									children: h(s.label) || c
								})]
							}),
							/* @__PURE__ */ i("p", {
								className: "my-2 break-all text-xs text-[#556176]",
								children: [
									c,
									" · ",
									s.mounted === !0 || s.mounted_by_target === !0 ? "当次证据：已挂载" : s.instantiated === !0 ? "已实例化" : "未观测到实例化",
									s.slot_id === null ? " · 非插入槽位" : ""
								]
							}),
							o.kind === "route" && h(s.path) && /* @__PURE__ */ r(G, {
								path: h(s.path),
								controller: t,
								disabled: e.stale || !!e.busy
							}),
							/* @__PURE__ */ r(I, {
								value: s,
								label: "目录证据"
							})
						]
					}, `${h(o.kind)}:${c}:${a}`);
				})
			}) : /* @__PURE__ */ r(L, {
				title: "尚未读取公开目录",
				children: "先选择目标并读取目录。普通 DOM 节点与面板不自动成为插入槽位。"
			}),
			typeof a.total == "number" && /* @__PURE__ */ i("p", {
				className: "text-xs text-[#556176]",
				children: [
					"目录总数 ",
					a.total,
					" · ",
					typeof a.nextOffset == "number" ? "仍有后续分页" : "当前目录页已到末尾"
				]
			}),
			typeof a.nextOffset == "number" && /* @__PURE__ */ r(N, {
				disabled: e.stale || !!e.busy,
				onClick: () => void t.overview(Number(a.nextOffset)),
				children: "下一页目录"
			})
		]
	});
}
function G({ path: t, controller: n, disabled: a }) {
	let [o, s] = e.useState(!1);
	return /* @__PURE__ */ i("div", {
		className: "my-2 flex flex-wrap items-center gap-2",
		children: [/* @__PURE__ */ i("label", {
			className: "text-[13px]",
			children: [/* @__PURE__ */ r("input", {
				type: "checkbox",
				checked: o,
				onChange: (e) => s(e.currentTarget.checked),
				className: "mr-2 accent-[#6C4CF5]"
			}), "确认导航到此公开路由"]
		}), /* @__PURE__ */ r(N, {
			disabled: a || !o,
			onClick: () => {
				n.navigate(t, o), s(!1);
			},
			children: "导航"
		})]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/schema.ts
function K(e, t = 0) {
	let n = p(e);
	if (n.default !== void 0) return _(n.default);
	if (n.const !== void 0) return _(n.const);
	if (m(n.enum).length) return _(m(n.enum)[0]);
	if (t > 12) return null;
	if (n.type === "object" || n.properties) {
		let e = new Set(m(n.required));
		return Object.fromEntries(Object.entries(p(n.properties)).filter(([t, n]) => e.has(t) || p(n).default !== void 0).map(([e, n]) => [e, K(_(n), t + 1)]));
	}
	return n.type === "array" ? [] : n.type === "boolean" ? !1 : n.type === "number" || n.type === "integer" ? typeof n.minimum == "number" ? n.minimum : 0 : n.type === "null" ? null : n.type === "string" ? "" : {};
}
function q(e, t, n = "输入", r = 0) {
	if (t === !1) return [`${n}不接受任何值`];
	if (r > 32) return [`${n}模式嵌套过深，请使用简化参数`];
	let i = p(t), a = [];
	Array.isArray(i.enum) && !i.enum.some((t) => JSON.stringify(t) === JSON.stringify(e)) && a.push(`${n}必须来自枚举`), i.const !== void 0 && JSON.stringify(i.const) !== JSON.stringify(e) && a.push(`${n}必须符合固定值`);
	let o = Array.isArray(i.type) ? i.type : typeof i.type == "string" ? [i.type] : [];
	if (o.length && !o.some((t) => t === "null" ? e === null : t === "array" ? Array.isArray(e) : t === "object" ? D(e) : t === "integer" ? typeof e == "number" && Number.isInteger(e) : typeof e === t)) return [`${n}类型应为 ${o.join(" / ")}`];
	if (D(e)) {
		let t = p(i.properties);
		for (let t of m(i.required)) typeof t == "string" && !(t in e) && a.push(`${n}.${t}为必填项`);
		for (let [o, s] of Object.entries(e)) t[o] === void 0 ? i.additionalProperties === !1 && a.push(`${n}.${o}不允许额外字段`) : a.push(...q(s, _(t[o]), `${n}.${o}`, r + 1));
	}
	return Array.isArray(e) && (typeof i.minItems == "number" && e.length < i.minItems && a.push(`${n}条目不足`), typeof i.maxItems == "number" && e.length > i.maxItems && a.push(`${n}条目过多`), i.items !== void 0 && e.forEach((e, t) => a.push(...q(e, _(i.items), `${n}[${t}]`, r + 1)))), typeof e == "number" && (typeof i.minimum == "number" && e < i.minimum && a.push(`${n}小于 ${i.minimum}`), typeof i.maximum == "number" && e > i.maximum && a.push(`${n}大于 ${i.maximum}`)), typeof e == "string" && (typeof i.minLength == "number" && [...e].length < i.minLength && a.push(`${n}长度不足`), typeof i.maxLength == "number" && [...e].length > i.maxLength && a.push(`${n}长度超限`)), a;
}
function J(e) {
	let t = p(e);
	return !t.$ref && !t.anyOf && !t.oneOf && !t.allOf && (t.type === "object" || t.properties !== void 0);
}
var Y = (e) => h(p(e).title) || h(p(e).description);
//#endregion
//#region ../examples/browser-debugger/src/invoke-view.tsx
function X({ value: t, onChange: n, onError: i, label: a }) {
	let [o, s] = e.useState(JSON.stringify(t, null, 2));
	return /* @__PURE__ */ r("textarea", {
		"aria-label": a,
		className: `${M} min-h-28 w-full font-mono`,
		value: o,
		onChange: (e) => {
			s(e.currentTarget.value);
			try {
				n(v(e.currentTarget.value)), i("");
			} catch (e) {
				i(e instanceof Error ? e.message : "JSON 无效");
			}
		}
	});
}
function te({ name: t, schema: n, value: a, required: o, onChange: s, onError: c }) {
	let l = p(n), u = m(l.enum), d = h(l.type), f = e.useId();
	return /* @__PURE__ */ i("div", {
		className: "space-y-1",
		children: [
			/* @__PURE__ */ i("label", {
				htmlFor: f,
				className: "flex items-center gap-2 text-[13px] font-medium",
				children: [
					Y(n) || t,
					/* @__PURE__ */ r("code", {
						className: "text-xs text-[#556176]",
						children: t
					}),
					o && /* @__PURE__ */ r("span", {
						className: "text-[#8A4D00]",
						children: "必填"
					}),
					!o && /* @__PURE__ */ r("input", {
						"aria-label": `填写 ${t}`,
						type: "checkbox",
						className: "accent-[#6C4CF5]",
						checked: a !== void 0,
						onChange: (e) => {
							s(e.currentTarget.checked ? K(n) : void 0), c("");
						}
					})
				]
			}),
			a !== void 0 && (u.length ? /* @__PURE__ */ r("select", {
				id: f,
				className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 w-full",
				value: JSON.stringify(a),
				onChange: (e) => s(v(e.currentTarget.value)),
				children: u.map((e, t) => /* @__PURE__ */ r("option", {
					value: JSON.stringify(e),
					children: typeof e == "string" ? e : JSON.stringify(e)
				}, t))
			}) : d === "boolean" ? /* @__PURE__ */ r(F, {
				checked: a === !0,
				onChange: s,
				children: "启用"
			}) : d === "number" || d === "integer" ? /* @__PURE__ */ r("input", {
				id: f,
				type: "number",
				className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 w-full",
				value: typeof a == "number" ? a : "",
				min: typeof l.minimum == "number" ? l.minimum : void 0,
				max: typeof l.maximum == "number" ? l.maximum : void 0,
				step: d === "integer" ? 1 : "any",
				onChange: (e) => {
					let n = e.currentTarget.valueAsNumber;
					Number.isFinite(n) ? (s(n), c("")) : c(`${t}需要有效数字`);
				}
			}) : d === "string" ? /* @__PURE__ */ r("input", {
				id: f,
				className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 w-full",
				value: typeof a == "string" ? a : "",
				onChange: (e) => s(e.currentTarget.value)
			}) : /* @__PURE__ */ r(X, {
				label: `${t} JSON`,
				value: a,
				onChange: s,
				onError: c
			}, t)),
			h(l.description) && /* @__PURE__ */ r("p", {
				className: "text-xs text-[#556176]",
				children: h(l.description)
			})
		]
	});
}
function ne({ state: t, controller: a }) {
	let [o, s] = e.useState(""), c = t.entries.find((e) => e.key === o), [l, u] = e.useState({}), [d, f] = e.useState(!1), [h, g] = e.useState({}), [v, y] = e.useState(!1), [b, x] = e.useState(!1), [S, C] = e.useState(!1);
	e.useEffect(() => {
		s(""), y(!1), x(!1), C(!1);
	}, [t.sessionId]);
	let w = (e) => {
		u(e), y(!1), x(!1);
	}, T = c ? [...Object.values(h).filter(Boolean), ...q(l, c.schema)] : [], E = p(p(c?.schema).properties), O = m(p(c?.schema).required);
	function k(e) {
		let n = t.entries.find((t) => t.key === e);
		s(e), u(n ? K(n.schema) : {}), f(n ? !J(n.schema) : !1), g({}), y(!1), x(!1), C(!1);
	}
	return /* @__PURE__ */ i("section", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ r("h2", {
				className: "text-[15px] font-semibold",
				children: "试调用公开入口"
			}),
			/* @__PURE__ */ r("p", {
				className: "rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
				children: "调用可能间接影响设备或外部资源。每次提交都需要两项确认，取消等待不代表停止执行；未知结果不自动重试。"
			}),
			t.entries.length ? /* @__PURE__ */ i(n, { children: [/* @__PURE__ */ i("label", {
				className: "block text-[13px]",
				children: ["当前插件公开目录", /* @__PURE__ */ i("select", {
					"aria-label": "试调用入口",
					className: `${M} mt-1 w-full`,
					value: o,
					onChange: (e) => k(e.currentTarget.value),
					children: [/* @__PURE__ */ r("option", {
						value: "",
						children: "请明确选择调用入口"
					}), t.entries.map((e) => /* @__PURE__ */ i("option", {
						value: e.key,
						children: [
							e.kind === "service" ? "服务" : e.kind === "operation" ? "操作" : "命令",
							" · ",
							e.id,
							e.version ? ` @ ${e.version}` : "",
							e.available ? "" : " · 当前不可用"
						]
					}, e.key))]
				})]
			}), c && /* @__PURE__ */ i("div", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ i("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [/* @__PURE__ */ r(P, { children: c.kind }), /* @__PURE__ */ i("code", {
							className: "break-all text-xs",
							children: [c.id, c.version ? ` @ ${c.version}` : ""]
						})]
					}),
					c.reason && /* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#556176]",
						children: c.reason
					}),
					J(c.schema) && /* @__PURE__ */ r(F, {
						checked: d,
						onChange: (e) => {
							f(e), g({}), y(!1), x(!1);
						},
						children: "改用完整 JSON 输入"
					}),
					!d && J(c.schema) && D(l) ? /* @__PURE__ */ r("div", {
						className: "grid grid-cols-2 gap-3 max-[700px]:grid-cols-1",
						children: Object.entries(E).map(([e, t]) => /* @__PURE__ */ r(te, {
							name: e,
							schema: _(t),
							value: l[e],
							required: O.includes(e),
							onChange: (t) => {
								let n = { ...l };
								t === void 0 ? delete n[e] : n[e] = t, w(n);
							},
							onError: (t) => g((n) => ({
								...n,
								[e]: t
							}))
						}, e))
					}) : /* @__PURE__ */ r(X, {
						label: "调用输入 JSON",
						value: l,
						onChange: w,
						onError: (e) => g({ input: e })
					}, `${o}:${d}`),
					/* @__PURE__ */ r("p", {
						className: "text-xs text-[#556176]",
						children: "表单依据 catalog 输入模式。复杂引用、组合条件与正则最终由原服务验证，原准入与错误保留。"
					}),
					T.length > 0 && /* @__PURE__ */ r("ul", {
						role: "alert",
						className: "list-inside list-disc text-[13px] text-[#8A4D00]",
						children: T.map((e, t) => /* @__PURE__ */ r("li", { children: e }, t))
					}),
					t.target?.kind === "browser" && /* @__PURE__ */ r(F, {
						checked: S,
						onChange: (e) => {
							C(e), y(!1), x(!1);
						},
						children: "本次包含脱敏结果正文（默认仅元数据）"
					}),
					/* @__PURE__ */ r(F, {
						checked: v,
						onChange: y,
						children: "确认调用当前插件、代次和入口，参数已核对"
					}),
					/* @__PURE__ */ r(F, {
						checked: b,
						onChange: x,
						children: "允许未知副作用，可能影响设备或外部资源"
					}),
					/* @__PURE__ */ r(N, {
						primary: !0,
						disabled: !!t.busy || t.stale || !t.connected || !c.available || !v || !b || T.length > 0,
						onClick: () => {
							a.invoke(c, l, v, b, S), y(!1), x(!1);
						},
						children: "执行一次调用"
					}),
					/* @__PURE__ */ r(I, {
						value: c.schema,
						label: "输入模式"
					})
				]
			})] }) : /* @__PURE__ */ r(L, {
				title: "当前目标没有可试调用的公开入口",
				children: "请先选择目标并刷新检查。服务器操作和服务均沿原任务执行，服务另需精确版本。"
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/timeline-view.tsx
function Z({ state: t, controller: a }) {
	let [o, s] = e.useState(""), [c, l] = e.useState(!0), [u, d] = e.useState(""), [f, g] = e.useState(!1), [_, v] = e.useState(null), [y, b] = e.useState(""), [x, C] = e.useState(!0), w = e.useRef(null);
	e.useEffect(() => {
		if (!f || !t.open || !t.sessionId || t.stale) return;
		let e = setInterval(() => {
			a.events();
		}, 3e3);
		return () => clearInterval(e);
	}, [
		a,
		f,
		t.open,
		t.sessionId,
		t.stale
	]), e.useEffect(() => {
		f && w.current?.scrollIntoView({ block: "nearest" });
	}, [t.events.length, f]);
	let T = t.events.filter((e) => (!o || e.level === o) && (c || !t.target || e.target && S(e.target) === S(t.target)) && (!u || `${e.label} ${e.logId ?? ""} ${e.target?.pluginId ?? ""}`.toLocaleLowerCase().includes(u.toLocaleLowerCase()))), E = p(t.logs);
	return /* @__PURE__ */ i("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ r("h2", {
				className: "text-[15px] font-semibold",
				children: "事件时间线与公共日志"
			}),
			/* @__PURE__ */ r("p", {
				className: "rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
				children: "历史清理失败保留；新代成功不会擦除旧代失败。只约束真实资源冲突，无需先清空旧债务。"
			}),
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-3",
				children: [
					/* @__PURE__ */ i("select", {
						"aria-label": "事件级别",
						className: M,
						value: o,
						onChange: (e) => s(e.currentTarget.value),
						children: [
							/* @__PURE__ */ r("option", {
								value: "",
								children: "全部级别"
							}),
							/* @__PURE__ */ r("option", {
								value: "info",
								children: "信息"
							}),
							/* @__PURE__ */ r("option", {
								value: "error",
								children: "错误 / 未确认"
							})
						]
					}),
					/* @__PURE__ */ i(F, {
						checked: c,
						onChange: l,
						children: ["包含旧代：", c ? "开" : "关"]
					}),
					/* @__PURE__ */ r("input", {
						"aria-label": "搜索事件",
						className: `${M} min-w-32 flex-1`,
						placeholder: "搜索事件、插件、日志 ID",
						value: u,
						onChange: (e) => d(e.currentTarget.value)
					}),
					/* @__PURE__ */ r("span", {
						className: "text-[13px] text-[#556176]",
						children: f ? "自动跟随中" : "已暂停跟随"
					}),
					/* @__PURE__ */ r(N, {
						onClick: () => g(!f),
						children: f ? "暂停跟随" : "继续跟随"
					}),
					/* @__PURE__ */ r(N, {
						disabled: !t.sessionId || !!t.busy,
						onClick: () => void a.events(),
						children: "读取下一页"
					})
				]
			}),
			(t.eventGap || t.droppedEvents > 0) && /* @__PURE__ */ i("p", {
				role: "status",
				className: "text-[13px] text-[#8A4D00]",
				children: [
					"事件游标存在缺口或截断：宿主已丢弃 ",
					t.droppedEvents,
					" 条。前端仅保留最近 500 条缓存，缺失不等于未发生。"
				]
			}),
			/* @__PURE__ */ i("div", {
				className: "grid grid-cols-[minmax(0,1.4fr)_minmax(230px,1fr)] gap-4 max-[700px]:grid-cols-1",
				children: [/* @__PURE__ */ i("section", {
					className: "max-h-80 min-w-0 overflow-auto rounded-lg border border-[#E6EAF3]",
					"aria-label": "事件列表",
					children: [T.length ? /* @__PURE__ */ i("table", {
						className: "w-full text-left text-[13px]",
						children: [/* @__PURE__ */ r("thead", {
							className: "sticky top-0 bg-[#F7F8FC] text-[#556176]",
							children: /* @__PURE__ */ i("tr", { children: [
								/* @__PURE__ */ r("th", {
									className: "p-2",
									children: "序号"
								}),
								/* @__PURE__ */ r("th", {
									className: "p-2",
									children: "事件"
								}),
								/* @__PURE__ */ r("th", {
									className: "p-2",
									children: "代次"
								})
							] })
						}), /* @__PURE__ */ r("tbody", { children: T.map((e) => /* @__PURE__ */ i("tr", {
							className: `${e.level === "error" ? "bg-[#FDF6ED]" : ""} border-t border-[#E6EAF3]`,
							children: [
								/* @__PURE__ */ r("td", {
									className: "p-2 font-mono text-xs",
									children: e.sequence
								}),
								/* @__PURE__ */ r("td", {
									className: "p-2",
									children: /* @__PURE__ */ r("button", {
										type: "button",
										className: "w-full break-all text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
										onClick: () => v(e),
										children: e.label
									})
								}),
								/* @__PURE__ */ r("td", {
									className: "p-2 font-mono text-xs",
									children: e.target?.generation ?? "未知"
								})
							]
						}, e.key)) })]
					}) : /* @__PURE__ */ r(L, {
						title: "暂无匹配的已缓存事件",
						children: "可手动读取下一页，或继续跟随。暂停仅影响自动读取，不暂停业务。"
					}), /* @__PURE__ */ r("div", { ref: w })]
				}), /* @__PURE__ */ r("section", {
					className: "min-w-0 space-y-3 rounded-lg border border-[#E6EAF3] p-3",
					"aria-label": "事件详情",
					children: _ ? /* @__PURE__ */ i(n, { children: [
						/* @__PURE__ */ r("h3", {
							className: "break-all text-sm font-medium",
							children: _.label
						}),
						/* @__PURE__ */ r(P, {
							warning: _.level === "error",
							children: _.level
						}),
						/* @__PURE__ */ i("p", {
							className: "break-all text-xs text-[#556176]",
							children: [
								_.target?.pluginId ?? "目标未知",
								" · ",
								_.target?.generation ?? "代次未知"
							]
						}),
						/* @__PURE__ */ r(B, { value: _.logId }),
						/* @__PURE__ */ r(I, {
							value: _.raw,
							label: "事件详情"
						})
					] }) : /* @__PURE__ */ r(L, { title: "选择事件查看详情" })
				})]
			}),
			/* @__PURE__ */ i("section", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("h3", {
						className: "text-sm font-semibold",
						children: "服务器公共日志搜索"
					}),
					/* @__PURE__ */ i("form", {
						className: "flex flex-wrap gap-2",
						onSubmit: (e) => {
							e.preventDefault(), a.logs(y, x);
						},
						children: [
							/* @__PURE__ */ i("select", {
								"aria-label": "日志查询方式",
								className: M,
								value: x ? "id" : "text",
								onChange: (e) => C(e.currentTarget.value === "id"),
								children: [/* @__PURE__ */ r("option", {
									value: "id",
									children: "日志 ID / 任务 ID"
								}), /* @__PURE__ */ r("option", {
									value: "text",
									children: "关键词"
								})]
							}),
							/* @__PURE__ */ r("input", {
								"aria-label": "日志查询",
								className: `${M} min-w-40 flex-1`,
								value: y,
								onChange: (e) => b(e.currentTarget.value),
								placeholder: x ? "填写完整日志 ID 或任务 ID" : "1 至 128 字节搜索词"
							}),
							/* @__PURE__ */ r(N, {
								type: "submit",
								disabled: !!t.busy || !y.trim(),
								children: "查询日志"
							}),
							t.logId && /* @__PURE__ */ r(N, {
								onClick: () => {
									C(!0), b(t.logId ?? "");
								},
								children: "带入最近日志 ID"
							})
						]
					}),
					E.limited === !0 && /* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#8A4D00]",
						children: "结果已截断，仅展示公开搜索返回的有界条目。"
					}),
					t.logs !== null && /* @__PURE__ */ r("div", {
						className: "max-h-72 overflow-auto",
						children: m(E.entries).length ? m(E.entries).map((e, t) => {
							let n = p(e);
							return /* @__PURE__ */ i("article", {
								className: "space-y-1 border-b border-[#E6EAF3] py-2 text-[13px]",
								children: [
									/* @__PURE__ */ i("div", {
										className: "flex flex-wrap gap-2",
										children: [
											/* @__PURE__ */ r(P, {
												warning: h(n.level).toLowerCase() === "error",
												children: h(n.level)
											}),
											/* @__PURE__ */ r("time", {
												className: "text-xs text-[#556176]",
												children: h(n.timestamp)
											}),
											/* @__PURE__ */ r("code", {
												className: "text-xs",
												children: h(n.code)
											})
										]
									}),
									/* @__PURE__ */ r("p", {
										className: "break-all",
										children: h(n.message)
									}),
									/* @__PURE__ */ r(B, { value: h(n.log_id) || null })
								]
							}, t);
						}) : /* @__PURE__ */ r("p", {
							className: "py-3 text-[13px] text-[#556176]",
							children: "未找到匹配的公开日志，不能据此推断业务没有运行。"
						})
					})
				]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/report.ts
function Q(e, t = Date.now()) {
	return _({
		format: "deviceforge-debugger-ui-v1",
		exported_at: new Date(t).toISOString(),
		target: e.target,
		session_id: e.sessionId,
		session_state: e.sessionState,
		stale: e.stale,
		last_observed_at: e.tree?.observedAt ?? null,
		evidence: e.report,
		inspection: e.inspection,
		cached_trees: e.trees.map((e) => e.raw),
		events: e.events.filter((t) => t.target?.pluginId === e.target?.pluginId),
		log_id: e.logId,
		limitations: [
			"仅公开服务返回的证据和本插件内存缓存",
			"过期快照不代表当前运行状态",
			"可能存在未观测、分页或截断；不是整套安装、设备或生产验收报告",
			"脱敏不能保证识别所有自由文本中的秘密，请按需分享"
		]
	});
}
var $ = (e) => e.replace(/[\\`*_{}\[\]<>|]/g, "\\$&").replace(/\r?\n/g, " ");
function re(e, t = Date.now()) {
	let n = e.target, r = [
		"# DeviceForge 调试报告",
		"",
		`导出时间：${new Date(t).toISOString()}`,
		"",
		`目标：${$(n?.pluginId ?? "未选定")}；类型：${n?.kind ?? "未知"}；代次：${$(n?.generation ?? "未知")}`,
		`实例：${$(n?.instanceId ?? "服务器目标或未提供")}`,
		`会话状态：${$(e.sessionState)}`,
		`快照：${e.stale ? "已过期，只读，不代表当前运行状态" : "最近一次公开观测"}`,
		"",
		"## 观测摘要",
		"",
		`缓存快照：${e.trees.length}；已加载节点：${e.tree?.nodes.length ?? 0}；事件缓存：${e.events.length}。`,
		`最近日志 ID：${$(e.logId ?? "未提供")}`,
		"",
		"## 事件摘要",
		"",
		"| 序号 | 事件 | 代次 |",
		"| --- | --- | --- |"
	];
	for (let t of e.events.filter((e) => e.target?.pluginId === n?.pluginId)) r.push(`| ${t.sequence} | ${$(t.label)} | ${$(t.target?.generation ?? "未知")} |`);
	return r.push("", "## 证据范围", "", "仅公开服务和已缓存观测；可能存在未观测、分页或截断。不是完整安装、设备或生产验收报告。", "", "## 公开证据", "", "````json", JSON.stringify(Q(e, t), null, 2).replace(/````/g, "\\u0060\\u0060\\u0060\\u0060"), "````", ""), r.join("\n");
}
function ie(e) {
	let t = /* @__PURE__ */ new Map(), n = e.defaultView?.URL;
	function r(r, i) {
		if (!n?.createObjectURL) throw Error("当前浏览器不支持文件下载，请使用宿主报告产物入口");
		let a = n.createObjectURL(r), o = e.createElement("a");
		o.href = a, o.download = i, o.className = "hidden", e.body.append(o);
		try {
			o.click();
		} finally {
			o.remove();
		}
		t.set(a, setTimeout(() => {
			n.revokeObjectURL(a), t.delete(a);
		}, 1e3));
	}
	return {
		save: r,
		dispose() {
			for (let [e, r] of t) clearTimeout(r), n?.revokeObjectURL(e);
			t.clear();
		}
	};
}
//#endregion
//#region ../examples/browser-debugger/src/report-pages.ts
function ae(e) {
	let t = p(e), n = p(p(t.report).evidence), r = [];
	for (let e of m(n.cached_trees)) {
		let t = p(e);
		for (let e of m(t.snapshots)) {
			let n = p(e), i = p(n.page);
			r.push({
				rootId: h(t.root_id),
				snapshotId: h(n.id),
				offset: g(i.offset),
				count: m(n.nodes).length
			});
		}
	}
	for (let e of m(t.ui_snapshot_pages)) {
		let t = p(e), n = p(t.tree), i = p(n.page);
		r.push({
			rootId: h(t.root_id),
			snapshotId: h(n.id),
			offset: g(i.offset),
			count: m(n.nodes).length
		});
	}
	for (let e of m(n.snapshot_manifest)) {
		let t = p(e), n = h(t.root_id);
		for (let e of m(t.snapshots)) {
			let t = p(e), i = h(t.id), a = g(t.total), o = 0;
			for (; o < a;) {
				let e = r.find((e) => e.rootId === n && e.snapshotId === i && e.offset === o && e.count > 0);
				if (!e) return {
					rootId: n,
					snapshotId: i,
					offset: o
				};
				o += e.count;
			}
		}
	}
	return null;
}
//#endregion
//#region ../examples/browser-debugger/src/report-view.tsx
function oe({ state: t, controller: n, context: a }) {
	let [o, s] = e.useState(!1), [c, l] = e.useState(!1), [u, d] = e.useState(""), f = e.useRef(null), g = e.useRef(null), _ = e.useRef(new AbortController());
	e.useEffect(() => {
		let e = _.current;
		return () => {
			e.abort(), g.current?.dispose();
		};
	}, []), e.useEffect(() => s(!1), [t.target?.pluginId, t.target?.generation]);
	function v(e) {
		let n = f.current?.ownerDocument;
		if (n) try {
			g.current ??= ie(n);
			let r = e === "json" ? JSON.stringify(Q(t), null, 2) : re(t);
			g.current.save(new Blob([r], { type: e === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" }), `deviceforge-debugger-${t.target?.pluginId ?? "snapshot"}-${Date.now()}.${e === "json" ? "json" : "md"}`), d("已请求浏览器下载当前公开证据，未自动采集新快照。");
		} catch (e) {
			d(e instanceof Error ? e.message : "下载失败");
		}
	}
	let y = p(p(p(t.report).artifact).metadata);
	async function b() {
		let e = h(y.id), t = f.current?.ownerDocument;
		if (a.artifacts && e && t) try {
			let n = AbortSignal.any([
				a.signal,
				_.current.signal,
				AbortSignal.timeout(15e3)
			]), r = await a.artifacts.download(e, n);
			n.throwIfAborted(), g.current ??= ie(t), g.current.save(r.data, h(y.filename, `debugger-report-${e}.json`)), d("已通过公开产物接口请求下载。");
		} catch (e) {
			_.current.signal.aborted || d(e instanceof Error ? e.message : "报告产物下载失败");
		}
	}
	let x = p(t.installation);
	return /* @__PURE__ */ i("div", {
		ref: f,
		className: "space-y-4",
		children: [
			/* @__PURE__ */ i("section", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("h2", {
						className: "text-[15px] font-semibold",
						children: "调试报告"
					}),
					/* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#556176]",
						children: "报告汇总当前目标的公开元数据与已缓存快照，不自动采集 UI、不执行命令。断线仍可下载带过期标记的本地缓存。"
					}),
					/* @__PURE__ */ i("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [/* @__PURE__ */ r(P, {
							warning: t.stale,
							children: t.stale ? "缓存已过期" : "最近公开证据"
						}), /* @__PURE__ */ i("span", {
							className: "text-[13px]",
							children: [t.trees.length, " 个缓存快照"]
						})]
					}),
					/* @__PURE__ */ r(F, {
						checked: c,
						onChange: l,
						children: "请求宿主持久报告产物（以实际返回 artifact 为准）"
					}),
					/* @__PURE__ */ i("div", {
						className: "flex flex-wrap gap-2",
						children: [
							/* @__PURE__ */ r(N, {
								disabled: !t.sessionId || t.stale || !!t.busy,
								onClick: () => void n.report(c, "json"),
								children: "汇总公开报告"
							}),
							/* @__PURE__ */ r(N, {
								disabled: !t.target,
								onClick: () => v("json"),
								children: "下载 JSON"
							}),
							/* @__PURE__ */ r(N, {
								disabled: !t.target,
								onClick: () => v("markdown"),
								children: "下载 Markdown"
							}),
							h(y.id) && /* @__PURE__ */ r(N, {
								disabled: !a.artifacts,
								onClick: () => void b(),
								children: "下载宿主报告产物"
							})
						]
					}),
					h(y.id) && /* @__PURE__ */ i("dl", { children: [/* @__PURE__ */ r(R, {
						label: "持久产物",
						children: /* @__PURE__ */ r("code", { children: h(y.id) })
					}), /* @__PURE__ */ r(R, {
						label: "文件",
						children: h(y.filename, "宿主未提供文件名")
					})] }),
					ae(t.report) && /* @__PURE__ */ i("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [/* @__PURE__ */ r("p", {
							className: "text-[13px] text-[#8A4D00]",
							children: "报告仍有缓存快照页尚未加载；本地下载会如实保留当前完整性。"
						}), /* @__PURE__ */ r(N, {
							disabled: t.stale || !!t.busy,
							onClick: () => void n.reportNext(),
							children: "读取报告下一页"
						})]
					}),
					t.report !== null && /* @__PURE__ */ r(I, {
						value: t.report,
						label: "报告证据与快照清单"
					}),
					/* @__PURE__ */ r("p", {
						role: "status",
						className: "text-[13px] text-[#556176]",
						children: u
					}),
					/* @__PURE__ */ r(B, { value: t.logId })
				]
			}),
			/* @__PURE__ */ i("section", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("h2", {
						className: "text-[15px] font-semibold",
						children: "安装组件与运行修订"
					}),
					/* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#556176]",
						children: "只读查询部署与当前运行代次。旧独立包缺少摘要时显示未知，不用文件名或版本推断运行代码已经更新。"
					}),
					/* @__PURE__ */ r(N, {
						disabled: !!t.busy,
						onClick: () => void n.installation(),
						children: "查询安装与修订"
					}),
					t.installation !== null && /* @__PURE__ */ i("div", {
						className: "space-y-3",
						children: [
							m(x.installations).map((e, t) => {
								let n = p(e);
								return /* @__PURE__ */ i("article", {
									className: "rounded-md border border-[#E6EAF3] p-3",
									children: [
										/* @__PURE__ */ i("h3", {
											className: "break-all text-sm font-medium",
											children: [
												h(n.id),
												" · ",
												h(n.version)
											]
										}),
										/* @__PURE__ */ i("p", {
											className: "my-2 break-all text-xs text-[#556176]",
											children: [
												"安装修订 ",
												h(n.revision, "未知"),
												" · ",
												h(n.status)
											]
										}),
										m(n.components).map((e, t) => {
											let n = p(e);
											return /* @__PURE__ */ i("div", {
												className: "flex flex-wrap items-center gap-2 border-t border-[#E6EAF3] py-2 text-[13px]",
												children: [
													/* @__PURE__ */ r("code", {
														className: "break-all",
														children: h(n.id)
													}),
													/* @__PURE__ */ r(P, { children: h(n.kind) }),
													/* @__PURE__ */ r(P, {
														warning: n.build_state !== "current",
														children: n.build_state === "current" ? "运行修订已核对" : n.build_state === "refresh_required" ? "需更新运行实例" : "尚未观测构建"
													}),
													/* @__PURE__ */ i("span", {
														className: "break-all text-xs text-[#556176]",
														children: [
															"运行代次 ",
															h(n.running_generation, "未知"),
															" · 运行修订 ",
															h(n.running_revision, "未知")
														]
													})
												]
											}, t);
										})
									]
								}, t);
							}),
							m(x.standalone).map((e, t) => {
								let n = p(e);
								return /* @__PURE__ */ i("article", {
									className: "space-y-1 rounded-md border border-[#E6EAF3] p-3 text-[13px]",
									children: [/* @__PURE__ */ i("p", {
										className: "break-all font-medium",
										children: [
											h(n.id),
											" · ",
											h(n.kind),
											" · ",
											h(n.version)
										]
									}), /* @__PURE__ */ i("p", {
										className: "text-[#556176]",
										children: [
											"部署摘要：",
											h(n.digest, "未知"),
											" · ",
											h(n.digest_status, "宿主未观测")
										]
									})]
								}, t);
							}),
							!m(x.installations).length && !m(x.standalone).length && /* @__PURE__ */ r(L, { title: "未查询到已安装组件" }),
							/* @__PURE__ */ r("p", {
								className: "text-[13px] text-[#556176]",
								children: h(x.note)
							}),
							/* @__PURE__ */ r(I, {
								value: x.running,
								label: "当前运行代次清单"
							})
						]
					})
				]
			}),
			/* @__PURE__ */ i("section", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("h2", {
						className: "text-[15px] font-semibold",
						children: "重载明确选定插件"
					}),
					/* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#8A4D00]",
						children: "重载当前浏览器插件运行实例会卸载其界面与资源。取消等待可能留下未确认结果，请先查询，不自动重复重载。"
					}),
					/* @__PURE__ */ i("p", {
						className: "break-all text-[13px]",
						children: [
							"选定：",
							/* @__PURE__ */ r("code", { children: t.target?.pluginId ?? "未选择" }),
							" · 代次 ",
							/* @__PURE__ */ r("code", { children: t.target?.generation ?? "未知" })
						]
					}),
					/* @__PURE__ */ r(F, {
						checked: o,
						onChange: s,
						children: "确认只重载上述插件和代次，随后核对新代次"
					}),
					/* @__PURE__ */ r(N, {
						disabled: !t.sessionId || t.stale || !!t.busy || !o,
						onClick: () => {
							n.reload(o), s(!1);
						},
						children: "重载此插件一次"
					})
				]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/view.tsx
var se = [
	{
		id: "targets",
		label: "调试目标"
	},
	{
		id: "tree",
		label: "UI 树"
	},
	{
		id: "catalog",
		label: "公开目录"
	},
	{
		id: "invoke",
		label: "试调用"
	},
	{
		id: "timeline",
		label: "事件与日志"
	},
	{
		id: "report",
		label: "报告与重载"
	}
];
function ce({ controller: t, context: a }) {
	let f = e.useSyncExternalStore(t.subscribe, t.snapshot, t.snapshot), [p, m] = e.useState("targets"), [h, g] = e.useState(!1), [_, v] = e.useState(!1), [y, b] = e.useState({
		x: 16,
		y: 64,
		width: 1032,
		height: 640
	}), [x, S] = e.useState({
		x: 16,
		y: 16
	}), [C, w] = e.useState(null), T = e.useRef(null), E = e.useRef(null), D = e.useRef(null), O = e.useRef(!1), k = e.useRef(null), A = () => {
		let e = E.current?.ownerDocument.defaultView;
		return {
			width: e?.innerWidth ?? 1424,
			height: e?.innerHeight ?? 805
		};
	};
	e.useEffect(() => {
		let e = E.current?.ownerDocument.defaultView;
		if (!e) return;
		b(s(A())), S(u(e.innerWidth - 72, e.innerHeight - 64, A(), !0));
		let t = () => {
			b((e) => o(e, A())), S((e) => u(e.x, e.y, A(), !0));
		};
		return e.addEventListener("resize", t), () => e.removeEventListener("resize", t);
	}, []), e.useEffect(() => {
		if (!f.open) return;
		let e = requestAnimationFrame(() => T.current?.focus());
		return () => cancelAnimationFrame(e);
	}, [f.open]), e.useEffect(() => {
		f.requested && m("targets");
	}, [f.requested]), e.useEffect(() => {
		f.sessionId && (m(f.target?.kind === "server" ? "invoke" : "tree"), g(!1));
	}, [f.sessionId]), e.useEffect(() => {
		f.stale && g(!1);
	}, [f.stale]), e.useEffect(() => {
		if (!f.open) return;
		let e = setInterval(() => {
			t.checkConnection();
		}, 5e3);
		return () => clearInterval(e);
	}, [f.open, t]), e.useEffect(() => {
		if (!f.busy?.startsWith("拾取")) return;
		let e = E.current?.ownerDocument, n = (e) => {
			e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), t.cancel(), T.current?.focus());
		};
		return e?.addEventListener("keydown", n, !0), () => e?.removeEventListener("keydown", n, !0);
	}, [f.busy, t]);
	function j() {
		t.collapse(), w(null), E.current?.focus();
	}
	function M(e, t) {
		t.button === 0 && (e === "move" && t.target instanceof Element && t.target.closest("button,input,select,textarea,a") || (t.currentTarget.setPointerCapture(t.pointerId), k.current = {
			mode: e,
			pointerId: t.pointerId,
			x: t.clientX,
			y: t.clientY,
			rect: y,
			ball: x,
			moved: !1
		}));
	}
	function I(e) {
		let t = k.current;
		if (!t || t.pointerId !== e.pointerId) return;
		let n = e.clientX - t.x, r = e.clientY - t.y;
		Math.abs(n) + Math.abs(r) > 5 && (t.moved = !0), t.moved && (t.mode === "ball" ? S(u(t.ball.x + n, t.ball.y + r, A(), !1)) : t.mode === "move" ? b(o({
			...t.rect,
			x: t.rect.x + n,
			y: t.rect.y + r
		}, A())) : b(o({
			...t.rect,
			width: t.rect.width + n,
			height: t.rect.height + r
		}, A())));
	}
	function R(e) {
		let t = k.current;
		t && t.pointerId === e.pointerId && (e.currentTarget.hasPointerCapture(e.pointerId) && e.currentTarget.releasePointerCapture(e.pointerId), k.current = null, t.mode === "ball" && t.moved ? (S((e) => u(e.x, e.y, A(), !0)), O.current = !0) : t.mode === "move" && t.moved && b((e) => c(e, A())));
	}
	let z = {
		"--df-x": `${y.x}px`,
		"--df-y": `${y.y}px`,
		"--df-width": `${y.width}px`,
		"--df-height": `${y.height}px`
	}, H = {
		"--df-x": `${x.x}px`,
		"--df-y": `${x.y}px`
	}, G = f.stale || !!f.instanceId && !f.connected, K = G && !h && (p === "tree" || p === "invoke" || p === "catalog"), q = !!f.sessionId && !f.stale && f.connected && !f.busy;
	return /* @__PURE__ */ i("div", {
		"data-deviceforge-debugger": "",
		"data-deviceforge-debugger-internal": "",
		className: "font-sans text-[#23272E]",
		children: [
			/* @__PURE__ */ r("style", { children: d }),
			/* @__PURE__ */ i("button", {
				ref: E,
				type: "button",
				"aria-label": f.open ? "收起调试器" : "打开调试器",
				"aria-expanded": f.open,
				"aria-controls": "deviceforge-debugger-panel",
				className: "fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483001] flex size-12 touch-none select-none flex-col items-center justify-center rounded-full border border-white bg-[#6C4CF5] text-xs font-medium text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] focus-visible:ring-offset-2",
				style: H,
				onPointerDown: (e) => M("ball", e),
				onPointerMove: I,
				onPointerUp: R,
				onPointerCancel: R,
				onKeyDown: (e) => {
					if (!e.altKey || !e.key.startsWith("Arrow")) return;
					e.preventDefault();
					let t = e.shiftKey ? 32 : 8;
					S((n) => u(n.x + (e.key === "ArrowRight" ? t : e.key === "ArrowLeft" ? -t : 0), n.y + (e.key === "ArrowDown" ? t : e.key === "ArrowUp" ? -t : 0), A(), !1));
				},
				onClick: () => {
					O.current ? O.current = !1 : f.open ? j() : t.open();
				},
				title: "调试器；拖动吸边，Alt + 方向键移动",
				children: [/* @__PURE__ */ r("span", {
					"aria-hidden": "true",
					children: "⌘"
				}), /* @__PURE__ */ r("span", { children: "调试" })]
			}),
			f.open && /* @__PURE__ */ i("section", {
				ref: T,
				id: "deviceforge-debugger-panel",
				role: "dialog",
				"aria-modal": "false",
				"aria-labelledby": "deviceforge-debugger-title",
				tabIndex: -1,
				style: z,
				className: "fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483000] flex h-[var(--df-height)] w-[var(--df-width)] min-w-0 flex-col overflow-hidden rounded-xl border border-[#E6EAF3] bg-white shadow-2xl outline-none",
				onKeyDown: (e) => {
					C ? (e.key.startsWith("Arrow") && (e.preventDefault(), e.stopPropagation(), b((t) => l(t, e.key, e.shiftKey, A()))), e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), b(o(C, A())), w(null), D.current?.focus()), e.key === "Enter" && (e.preventDefault(), e.stopPropagation(), w(null), D.current?.focus())) : e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), f.busy?.startsWith("拾取") ? t.cancel() : j());
				},
				children: [
					/* @__PURE__ */ i("header", {
						className: "flex h-12 shrink-0 touch-none items-center gap-3 border-b border-[#E6EAF3] px-4 select-none",
						onPointerDown: (e) => M("move", e),
						onPointerMove: I,
						onPointerUp: R,
						onPointerCancel: R,
						children: [
							/* @__PURE__ */ r("h1", {
								id: "deviceforge-debugger-title",
								className: "mr-auto truncate text-[17px] font-semibold",
								children: "DeviceForge Debugger"
							}),
							/* @__PURE__ */ r(P, {
								warning: G,
								children: G ? "已断线 / 过期" : f.connected ? "已连接" : "待连接"
							}),
							/* @__PURE__ */ r(N, {
								"aria-label": "收起调试器，保留会话",
								onClick: j,
								children: "收起"
							}),
							/* @__PURE__ */ r(N, {
								"aria-label": "关闭调试会话",
								onClick: () => {
									t.close().then(() => E.current?.focus());
								},
								children: "关闭"
							})
						]
					}),
					/* @__PURE__ */ i("div", {
						className: "flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#E6EAF3] px-4 py-2 text-xs text-[#556176]",
						children: [
							/* @__PURE__ */ i("span", {
								className: "min-w-0 break-all",
								title: f.target?.instanceId ?? f.instanceId ?? "",
								children: ["实例 ", /* @__PURE__ */ r("code", { children: f.target?.instanceId ?? f.instanceId ?? "未连接" })]
							}),
							/* @__PURE__ */ i("span", {
								className: "min-w-0 break-all",
								children: ["插件 ", /* @__PURE__ */ r("code", { children: f.target?.pluginId ?? "未选择" })]
							}),
							/* @__PURE__ */ i("span", {
								className: "break-all",
								children: ["代次 ", /* @__PURE__ */ i("code", { children: [f.target?.generation ?? "未提供", f.stale ? "（旧）" : ""] })]
							})
						]
					}),
					/* @__PURE__ */ i("div", {
						className: "flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[#E6EAF3] px-4 py-1.5 text-[13px]",
						children: [
							/* @__PURE__ */ r("span", {
								className: "mr-auto text-[#556176]",
								children: f.sessionId ? `会话 ${f.sessionState}` : "选择插件后才开始采集"
							}),
							/* @__PURE__ */ r(N, {
								onClick: () => m("targets"),
								children: "选择其他目标"
							}),
							/* @__PURE__ */ r(N, {
								disabled: !q,
								onClick: () => void t.refreshInspection(),
								children: "检查目标"
							})
						]
					}),
					/* @__PURE__ */ r("nav", {
						"aria-label": "调试页签",
						className: "flex min-h-10 shrink-0 gap-1 overflow-x-auto border-b border-[#E6EAF3] px-3",
						children: se.map((e) => /* @__PURE__ */ r("button", {
							type: "button",
							"aria-current": p === e.id ? "page" : void 0,
							className: `${p === e.id ? "border-[#6C4CF5] text-[#6C4CF5]" : "border-transparent text-[#556176]"} shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`,
							onClick: () => m(e.id),
							children: e.label
						}, e.id))
					}),
					/* @__PURE__ */ i("div", {
						className: "flex min-h-0 flex-1 flex-col overflow-auto p-4",
						children: [f.error && /* @__PURE__ */ i("div", {
							role: "alert",
							className: "mb-3 space-y-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
							children: [
								/* @__PURE__ */ r("p", { children: f.error.message }),
								/* @__PURE__ */ r("code", {
									className: "block break-all text-xs",
									children: f.error.code
								}),
								/* @__PURE__ */ r(B, { value: f.error.logId })
							]
						}), K ? /* @__PURE__ */ i("div", {
							className: "space-y-4",
							children: [
								/* @__PURE__ */ i(L, {
									title: "连接已断开，当前状态未知",
									children: ["最后快照与历史日志仍可查看。重新连接只恢复观察；原调用不自动重放。", f.tree && /* @__PURE__ */ i("p", {
										className: "mt-2",
										children: [
											"最后观测：",
											new Date(f.tree.observedAt).toLocaleString(),
											" · 旧代次 ",
											f.target?.generation
										]
									})]
								}),
								/* @__PURE__ */ i("div", {
									className: "flex flex-wrap gap-2",
									children: [
										/* @__PURE__ */ r(N, {
											disabled: !f.tree,
											onClick: () => {
												g(!0), m("tree");
											},
											children: "查看最后快照（只读 / 已过期）"
										}),
										/* @__PURE__ */ r(N, {
											onClick: () => m("timeline"),
											children: "查看历史日志"
										}),
										/* @__PURE__ */ r(N, {
											onClick: () => m("targets"),
											children: "选择其他目标"
										})
									]
								}),
								/* @__PURE__ */ r(F, {
									checked: _,
									onChange: v,
									children: "确认建立新浏览器实例，不重放原调用"
								}),
								/* @__PURE__ */ r(N, {
									disabled: !_ || !!f.busy,
									primary: !0,
									onClick: () => {
										t.reconnect(_), v(!1);
									},
									children: "重新连接"
								})
							]
						}) : /* @__PURE__ */ i(n, { children: [
							G && h && p === "tree" && /* @__PURE__ */ i("div", {
								className: "mb-3 flex flex-wrap items-center gap-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
								children: [/* @__PURE__ */ r("span", {
									className: "mr-auto",
									children: "已过期：仅最后观测，不代表当前运行状态；所有节点动作已停用。"
								}), /* @__PURE__ */ r(N, {
									onClick: () => g(!1),
									children: "返回断线摘要"
								})]
							}),
							p === "targets" && /* @__PURE__ */ r(ee, {
								state: f,
								controller: t
							}),
							p === "tree" && /* @__PURE__ */ r(U, {
								state: f,
								controller: t
							}),
							p === "catalog" && /* @__PURE__ */ r(W, {
								state: f,
								controller: t
							}),
							p === "invoke" && /* @__PURE__ */ r(ne, {
								state: f,
								controller: t
							}),
							p === "timeline" && /* @__PURE__ */ r(Z, {
								state: f,
								controller: t
							}),
							p === "report" && /* @__PURE__ */ r(oe, {
								state: f,
								controller: t,
								context: a
							}),
							(p === "tree" || p === "invoke") && /* @__PURE__ */ r("div", {
								className: "mt-3",
								children: /* @__PURE__ */ r(V, { value: f.result })
							})
						] })]
					}),
					/* @__PURE__ */ i("footer", {
						className: "relative flex min-h-11 shrink-0 items-center gap-2 border-t border-[#E6EAF3] bg-[#FBFCFE] px-4 pr-10 py-1.5",
						children: [
							/* @__PURE__ */ r("p", {
								role: "status",
								title: f.notice,
								className: "mr-auto min-w-0 truncate text-[13px] text-[#556176]",
								children: C ? "方向键每次 8px，Shift 32px；Enter 应用，Esc 取消" : f.busy ? `正在${f.busy}` : f.notice
							}),
							f.busy && /* @__PURE__ */ r(N, {
								onClick: () => t.cancel(),
								children: "取消等待"
							}),
							/* @__PURE__ */ r("button", {
								ref: D,
								type: "button",
								"aria-pressed": !!C,
								className: "shrink-0 rounded-md border border-[#E6EAF3] bg-white px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
								onClick: () => {
									w(C ? null : y), D.current?.focus();
								},
								children: "键盘调尺寸"
							}),
							/* @__PURE__ */ r(N, {
								disabled: !q,
								onClick: () => void t.refreshInspection(),
								children: G ? "刷新不可用" : "刷新检查"
							}),
							/* @__PURE__ */ r("button", {
								type: "button",
								"aria-label": "拖动调整调试面板尺寸",
								className: "absolute right-0 bottom-0 flex size-7 touch-none cursor-se-resize items-center justify-center rounded-br-xl text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
								onPointerDown: (e) => M("resize", e),
								onPointerMove: I,
								onPointerUp: R,
								onPointerCancel: R,
								onKeyDown: (e) => {
									e.key.startsWith("Arrow") && (e.preventDefault(), b((t) => l(t, e.key, e.shiftKey, A())));
								},
								children: "╱╱"
							})
						]
					})
				]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/controller.ts
function le(e) {
	let t = k(e), n = new AbortController(), r = /* @__PURE__ */ new Set(), i = /* @__PURE__ */ new Set(), a = new AbortController(), o = 0, s = !1, c = 0, l = {
		open: !1,
		busy: null,
		connected: !1,
		stale: !1,
		instanceId: null,
		targets: [],
		target: null,
		sessionId: null,
		sessionState: "none",
		capabilities: null,
		inspection: null,
		roots: [],
		rootId: "",
		tree: null,
		trees: [],
		selectedNodeId: "",
		queries: null,
		entries: [],
		events: [],
		cursor: 0,
		eventGap: !1,
		droppedEvents: 0,
		result: null,
		report: null,
		overview: null,
		installation: null,
		logs: null,
		requested: null,
		error: null,
		notice: "首次只显示调试入口；打开后连接，明确选择目标后才采集。",
		logId: null
	}, u = () => l;
	function d(e) {
		if (!s) {
			l = {
				...l,
				...e
			};
			for (let e of r) e();
		}
	}
	function f(e, t, n, r) {
		let i = {
			key: `local-${++c}`,
			sequence: c,
			target: l.target,
			sessionId: l.sessionId ?? "",
			level: n,
			label: e,
			logId: r,
			raw: t
		};
		d({ events: [...l.events, i].slice(-500) });
	}
	function v() {
		return a.abort(), a = new AbortController(), o++, o;
	}
	let y = () => Math.min(12e4, Math.max(45e3, g(p(l.capabilities).reload_timeout_ms, 5e4)));
	async function D(t, r, i = !1, c = 15e3) {
		if (s || e.signal.aborted) return;
		if (l.busy && !i) {
			d({ notice: `正在${l.busy}，可取消当前等待后再操作。` });
			return;
		}
		i && v();
		let u = o, p = AbortSignal.any([
			a.signal,
			n.signal,
			e.signal,
			AbortSignal.timeout(c)
		]);
		d({
			busy: t,
			error: null
		});
		try {
			await x(r(p), p);
		} catch (e) {
			if (u !== o || s) return;
			let n = b(e);
			f(t, {
				code: n.code,
				message: n.message,
				unconfirmed: n.unconfirmed
			}, "error", n.logId), d({
				error: n,
				logId: n.logId ?? l.logId,
				notice: n.unconfirmed ? "结果未确认；请查询状态，独立新操作仍可显式发起。不会自动重放。" : n.message
			}), /disconnect|inactive_session|stale_target|target_changed|wrong_instance|stale_generation/.test(n.code) && d({
				stale: !0,
				connected: !1,
				sessionState: "disconnected"
			});
		} finally {
			!s && u === o && d({ busy: null });
		}
	}
	async function A(e, n, r) {
		let i = l.sessionId;
		if (!i || !l.target) throw Error("请先明确选择调试目标并打开会话");
		if (l.stale || !l.connected) throw Error("当前为过期只读快照，请重新连接并核对目标代次");
		let a = await t.call(e, {
			session_id: i,
			parameters: n
		}, r, e === "reload" ? y() : 15e3);
		return r.throwIfAborted(), d({ logId: a.logId ?? l.logId }), a.data;
	}
	function j(e, t = !1) {
		let n = p(e), r = E(n.tree);
		if (!r) {
			let e = m(n.roots).map((e) => ({
				id: h(p(e).root_id),
				label: h(p(e).contribution_id)
			})).filter((e) => e.id);
			d({
				notice: h(n.reason, "当前目标未提供可读取的 UI 树"),
				...e.length ? { roots: e } : {}
			});
			return;
		}
		let i = l.tree, a = t && i?.id === r.id ? {
			...r,
			nodes: [...new Map([...i.nodes, ...r.nodes].map((e) => [e.id, e])).values()]
		} : r;
		d({
			tree: a,
			trees: [...l.trees.filter((e) => e.id !== a.id), a].slice(-10),
			rootId: h(n.root_id, l.rootId),
			stale: !1,
			queries: null,
			selectedNodeId: a.nodes.some((e) => e.id === l.selectedNodeId) ? l.selectedNodeId : "",
			notice: "已读取观测结构；可观测不等于可插入，DOM 存在不证明像素可见或业务成功。"
		});
	}
	function M(e) {
		let t = l.tree;
		if (!t) return;
		let n = E({
			id: t.id,
			observedAt: t.observedAt,
			nodes: m(p(e).nodes)
		});
		n && d({ tree: {
			...t,
			nodes: [...new Map([...t.nodes, ...n.nodes].map((e) => [e.id, e])).values()]
		} });
	}
	async function N(e, t) {
		let n = await A("inspect", {}, e), r = m(p(n).roots).map((e) => ({
			id: h(p(e).root_id),
			label: h(p(e).contribution_id)
		})).filter((e) => e.id);
		d({
			inspection: n,
			entries: O(n),
			roots: r,
			rootId: r.some((e) => e.id === l.rootId) ? l.rootId : r.length === 1 ? r[0]?.id ?? "" : "",
			notice: r.length > 1 ? "此目标有多个挂载根，请明确选择一个后读取 UI 树。" : "已检查公开目录与代次。"
		}), t && l.target?.kind === "browser" && r.length === 1 && j(await A("ui_tree", { root_id: r[0]?.id ?? "" }, e));
	}
	async function P(e) {
		let n = await t.call("targets", {}, e);
		e.throwIfAborted(), d({
			targets: T(n.data),
			logId: n.logId ?? l.logId
		});
	}
	async function F(e, n) {
		await t.call("session", {
			action: "close",
			session_id: e
		}, n), n.throwIfAborted(), i.delete(e);
	}
	async function I(e) {
		await D("切换目标", async (n) => {
			let r = l.sessionId;
			d({
				target: e,
				sessionId: null,
				sessionState: "opening",
				tree: null,
				trees: [],
				inspection: null,
				roots: [],
				rootId: "",
				entries: [],
				selectedNodeId: "",
				queries: null,
				cursor: 0,
				result: null,
				report: null,
				stale: !1,
				notice: "正在打开明确选定目标的调试会话"
			}), r && await F(r, n);
			let a = await t.call("session", {
				action: "open",
				target: C(e)
			}, n), o = p(a.data), s = h(o.session_id);
			if (s && i.add(s), n.throwIfAborted(), !s || o.state !== "active") throw Error("宿主没有返回有效活动会话");
			let c = w(o.target);
			if (!c || S(c) !== S(e)) throw Error("会话身份与明确选定目标不一致");
			d({
				sessionId: s,
				sessionState: "active",
				connected: !0,
				logId: a.logId
			}), await N(n, !0);
		}, !0);
	}
	async function L() {
		s || l.busy || !l.open || await D("核对连接", async (e) => {
			let n = await t.service("status", {}, e);
			e.throwIfAborted();
			let r = p(p(n.data).bridge), i = h(r.instanceId) || h(r.instance_id), a = r.state === "connected";
			if (d({ capabilities: n.data }), (!l.target || l.target.kind === "browser" && l.target.instanceId === l.instanceId) && (!a || i !== l.instanceId)) d({
				connected: !1,
				stale: !0,
				sessionState: "disconnected",
				notice: h(r.reason, "连接已断开或实例已更换；保留最后快照，只读查看，不自动重放。")
			});
			else if (l.sessionId) {
				let n = await t.call("session", {
					action: "get",
					session_id: l.sessionId
				}, e);
				e.throwIfAborted();
				let r = p(n.data), i = w(r.target);
				(r.state !== "active" || !i || !l.target || S(i) !== S(l.target)) && d({
					stale: !0,
					connected: !1,
					sessionState: h(r.state, "target_changed"),
					notice: "会话或目标代次已改变，最后快照已过期；请明确重新选择当前目标。"
				});
			}
		});
	}
	async function R() {
		d({ open: !0 }), await D("连接调试桥", async (e) => {
			let n = await t.service("capabilities", {}, e);
			e.throwIfAborted(), d({ capabilities: n.data });
			let r = await t.service("start", {}, e);
			e.throwIfAborted();
			let i = h(p(r.data).instance_id);
			if (!i) throw Error("调试桥未返回当前实例标识");
			d({
				instanceId: i,
				connected: !0,
				notice: "已连接当前浏览器实例，请明确选择浏览器插件或服务器插件。"
			}), await P(e);
		});
	}
	function z() {
		if (s) return;
		s = !0, a.abort(), n.abort(), r.clear(), e.signal.removeEventListener("abort", z);
		let o = AbortSignal.timeout(2e3), c = [...i].map((e) => t.call("session", {
			action: "close",
			session_id: e
		}, o));
		return i.clear(), x(Promise.allSettled(c), o).then(() => void 0, () => void 0);
	}
	return e.signal.addEventListener("abort", z, { once: !0 }), e.signal.aborted && z(), {
		snapshot: u,
		subscribe(e) {
			return r.add(e), () => {
				r.delete(e);
			};
		},
		open: R,
		collapse() {
			d({ open: !1 });
		},
		cancel() {
			v(), d({
				busy: null,
				notice: "已取消当前等待；已派发副作用结果未确认，不会自动重放。"
			});
		},
		select: I,
		checkConnection: L,
		refreshTargets: () => D("刷新目标目录", P),
		async requestTargets(e, t = null) {
			e.length && (d({
				requested: {
					candidates: e,
					installationId: t
				},
				open: !0
			}), l.instanceId ? await D("带入市场目标", P, !0) : await R(), d({ notice: `市场已带入 ${e.length} 个候选组件，请核对实例、组件和代次后明确选择。` }));
		},
		clearRequested() {
			d({ requested: null });
		},
		reconnect: (e) => D("显式重新连接", async (n) => {
			if (!e) throw Error("重连将创建新浏览器实例，请先明确确认");
			let r = await t.service("reconnect", { input: { confirmed: e } }, n);
			n.throwIfAborted();
			let i = h(p(r.data).instance_id);
			if (!i || i === l.instanceId) throw Error("重连尚未返回不同的新实例，请核对桥状态");
			d({
				instanceId: i,
				connected: !0,
				stale: !!l.tree,
				sessionState: "disconnected",
				notice: "新实例已建立；旧快照仍过期。请明确选择当前插件新代，会话与原动作不自动重放。"
			}), await P(n);
		}, !0),
		installation: () => D("查询安装与运行修订", async (e) => {
			let n = await t.service("installation", {}, e);
			e.throwIfAborted(), d({
				installation: n.data,
				logId: n.logId
			});
		}),
		logs: (e, n) => D("搜索服务器公共日志", async (r) => {
			let i = {
				order: "desc",
				...n ? { log_id: e.trim() } : { q: e.trim() }
			}, a = await t.service("logs", { input: i }, r);
			r.throwIfAborted(), d({
				logs: a.data,
				logId: a.logId,
				notice: p(a.data).limited === !0 ? "日志搜索已受限截断；结果不是完整日志。" : "已读取服务器公共日志。"
			});
		}),
		refreshInspection: () => D("检查目标", (e) => N(e, !1)),
		async close() {
			await D("关闭调试会话", async (e) => {
				l.sessionId && await F(l.sessionId, e), d({
					open: !1,
					sessionId: null,
					sessionState: "closed",
					stale: !!l.tree,
					notice: "调试会话已关闭；业务插件与任务继续由原入口管理。"
				});
			}, !0);
		},
		setRoot(e) {
			l.roots.some((t) => t.id === e) && (v(), d({
				rootId: e,
				tree: null,
				trees: [],
				selectedNodeId: "",
				queries: null,
				busy: null
			}));
		},
		setNode(e) {
			l.tree?.nodes.some((t) => t.id === e) && d({ selectedNodeId: e });
		},
		tree: () => D("读取 UI 树", async (e) => {
			if (l.roots.length > 1 && !l.rootId) throw Error("请先明确选择挂载根");
			j(await A("ui_tree", l.rootId ? { root_id: l.rootId } : {}, e));
		}),
		nextTreePage: () => D("读取下一页节点", async (e) => {
			let t = l.tree, n = p(p(t?.raw).page);
			t && typeof n.nextOffset == "number" && j(await A("ui_tree", {
				root_id: l.rootId,
				snapshot_id: t.id,
				offset: n.nextOffset,
				limit: 500
			}, e), !0);
		}),
		overview: (e = 0) => D("读取公开挂载目录", async (t) => {
			d({
				overview: await A("ui_tree", {
					view: "overview",
					offset: e,
					limit: 100
				}, t),
				notice: "公开目录不代表页面已实例化；未挂载条目不生成 DOM 树。"
			});
		}),
		query: (e) => D("语义查询", async (t) => {
			let n = await A("ui_query", {
				root_id: l.rootId,
				query: e
			}, t);
			M(n), d({
				queries: m(p(n).nodes).map((e) => h(p(e).id)),
				result: n,
				notice: h(p(n).reason, "语义查询已完成；不完整观测不能证明节点不存在。")
			});
		}),
		clearQuery() {
			d({ queries: null });
		},
		navigate: (e, t) => D("导航到公开路由", async (n) => {
			if (!t) throw Error("导航需要本次显式确认");
			let r = await A("ui_action", { action: {
				type: "navigate",
				path: e,
				confirmed: t
			} }, n);
			d({
				result: r,
				notice: h(p(r).reason, "已请求导航，未证明页面或业务完成。")
			});
		}),
		assertion: (e) => D("执行结构断言", async (t) => {
			let n = await A("ui_assert", {
				root_id: l.rootId,
				assertion: e
			}, t);
			d({
				result: n,
				notice: `断言 ${h(p(n).status, "结果未知")}：${h(p(n).reason)}`
			});
		}),
		diff: (e, t) => D("比较快照", async (n) => {
			let r = await A("ui_diff", {
				root_id: l.rootId,
				before_id: e,
				after_id: t
			}, n);
			d({
				result: r,
				notice: h(p(r).reason, "已比较选定挂载根的两个快照。")
			});
		}),
		action: (e, t, n, r, i) => D(e === "pick" ? "拾取节点（Esc 取消）" : "执行节点动作", async (a) => {
			if (e !== "pick" && !t) throw Error("请先选择当前快照中的节点");
			if (e !== "highlight" && e !== "pick" && (!r || !i)) throw Error("请分别确认本次动作和未知副作用；可能间接影响设备");
			let o = e === "pick" ? { type: e } : {
				type: e,
				confirmed: r,
				allowUnknownSideEffects: i
			};
			t && e !== "pick" && (o.target = {
				id: t.id,
				generation: t.generation,
				revision: t.revision
			}), e === "fill" && (o.value = n), e === "select" && (o.values = n.split("\n").filter(Boolean));
			let s = await A("ui_action", {
				...l.rootId && e !== "pick" ? { root_id: l.rootId } : {},
				action: o
			}, a);
			if (d({
				result: s,
				notice: h(p(s).reason, "已收到节点动作回执；业务结果仍需核对。")
			}), f(`节点动作 ${e}`, s, "info", l.logId), e === "pick") {
				let e = p(s), t = p(e.owner), n = p(e.target);
				if (e.status === "picked" && t.pluginId === l.target?.pluginId && String(t.generation) === l.target?.generation) {
					let t = h(e.root_id);
					t && d({ rootId: t }), j(await A("ui_tree", t ? { root_id: t } : {}, a)), !l.tree?.nodes.some((e) => e.id === n.id) && h(n.id) && M(await A("ui_query", {
						root_id: l.rootId,
						query: {
							id: h(n.id),
							limit: 1
						}
					}, a)), l.tree?.nodes.some((e) => e.id === n.id) && d({ selectedNodeId: h(n.id) });
				} else e.source === "host-dom" ? d({
					selectedNodeId: "",
					notice: "已拾取宿主普通节点，仅展示只读身份；普通节点不能作为插件动作目标或插入槽位。"
				}) : e.status === "picked" && d({ notice: "拾取到其他插件，仅展示归属；请明确切换目标后再查看。" });
			}
		}),
		invoke: (e, t, n, r, i = !1) => D("试调用公开入口", async (a) => {
			if (!l.entries.some((t) => t.key === e.key) || !e.available) throw Error("调用入口不在当前目标目录中");
			if (!n || !r) throw Error("试调用需要分别确认本次调用和未知副作用");
			let o = {
				kind: e.kind,
				id: e.id,
				input: t,
				confirmed: n,
				allow_unknown_side_effects: r
			};
			l.target?.kind === "browser" && (o.include_result = i), e.version && (o.version = e.version);
			let s = await A("invoke", o, a);
			d({
				result: s,
				notice: "已收到调用回执；已接受或已派发不代表原业务完成，请核对原任务。"
			}), f(`试调用 ${e.id}`, s, "info", l.logId);
		}),
		reload: (e) => D("重载选定插件", async (t) => {
			let n = l.target;
			if (!n || !e) throw Error("请明确确认当前插件 ID 和代次后重载");
			let r = await A("reload", { confirmed: !0 }, t);
			d({ result: r }), f("插件重载", r, "info", l.logId), await P(t);
			let i = l.targets.find((e) => e.kind === n.kind && e.instanceId === n.instanceId && e.pluginId === n.pluginId);
			d({
				stale: !0,
				sessionState: "target_changed",
				notice: i?.generation && i.generation !== n.generation ? `已核到新代 ${i.generation}；请明确选择新代后继续观测，不重放原动作。` : "尚未核到不同的新代；请刷新目标目录检查结果，不自动重载或重放。"
			});
		}, !1, y()),
		events: () => D("读取下一页事件", async (e) => {
			let n = l.sessionId;
			if (!n) throw Error("请先选择调试会话；断线时可查看已缓存历史");
			let r = await t.call("events", {
				session_id: n,
				after: l.cursor,
				limit: 100
			}, e);
			e.throwIfAborted();
			let i = p(r.data), a = m(i.events).map((e) => {
				let t = p(e), i = h(t.command_state) || h(t.session_state);
				return {
					key: `${n}:${g(t.sequence)}`,
					sequence: g(t.sequence),
					target: l.target,
					sessionId: n,
					level: /failed|unconfirmed|disconnected/.test(i) ? "error" : "info",
					label: `${h(t.kind)} ${i}`.trim(),
					logId: h(t.log_id) || r.logId,
					raw: _(e)
				};
			});
			d({
				events: [...new Map([...l.events, ...a].map((e) => [e.key, e])).values()].slice(-500),
				cursor: g(i.next_after, l.cursor),
				eventGap: i.gap === !0,
				droppedEvents: g(i.dropped_events),
				logId: r.logId,
				notice: i.gap === !0 ? "事件游标存在缺口；请保留截断提示，不据此推断没有发生事件。" : "事件分页已更新。"
			});
		}),
		report: (e = !1, t = "json") => D("汇总调试报告", async (n) => {
			let r = await A("report", { export: e ? t : "none" }, n);
			d({
				report: r,
				notice: p(r).artifact ? "宿主已返回报告产物；可通过公开产物入口下载。" : "已汇总内存证据，可下载本地 JSON / Markdown；不是完整生产验收。"
			});
		}),
		reportNext: () => D("读取报告快照续页", async (e) => {
			let t = p(l.report), n = ae(l.report);
			if (!n) throw Error("报告没有可读取的快照续页");
			let r = p(await A("ui_tree", {
				root_id: n.rootId,
				snapshot_id: n.snapshotId,
				offset: n.offset,
				limit: 500
			}, e));
			if (!E(r.tree)) throw Error("报告快照续页未返回有效结构树");
			d({
				report: _({
					...t,
					ui_snapshot_pages: [...m(t.ui_snapshot_pages), r]
				}),
				notice: "已读取指定快照续页；报告仍保留分页与不完整观测说明。"
			});
		}),
		dispose: z
	};
}
//#endregion
//#region ../examples/browser-debugger/src/index.tsx
var ue = {
	id: "deviceforge_debugger",
	version: "0.1.0",
	apiVersion: 2,
	panels: [],
	contributions: { components: [{
		id: "deviceforge_debugger.floating",
		title: "DeviceForge 调试器",
		slot: "developer.tools",
		mode: "append",
		async mount(e, n) {
			let i = e.ownerDocument.createElement("div");
			i.setAttribute("data-deviceforge-debugger", ""), i.setAttribute("data-deviceforge-debugger-internal", ""), e.append(i);
			let a = le(n), o = t(i);
			o.render(/* @__PURE__ */ r(ce, {
				controller: a,
				context: n
			}));
			let s = n.extensions?.subscribeEvent("host.debugger.target_requested", (e) => {
				let t = p(e.data), n = (Array.isArray(t.candidates) ? m(t.candidates) : [t]).map((e) => ({
					kind: h(p(e).target_kind),
					pluginId: h(p(e).plugin_id)
				})).filter((e) => (e.kind === "browser" || e.kind === "server") && e.pluginId);
				a.requestTargets(n, h(t.installation_id) || null);
			}), c = !1, l = n.onDispose(async () => {
				c || (c = !0, s?.(), o.unmount(), i.remove(), await a.dispose());
			});
			return async () => {
				await l();
			};
		}
	}] }
};
//#endregion
export { ue as default };

//# sourceMappingURL=index.js.map