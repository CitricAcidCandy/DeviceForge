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
		x: e.width >= 1280 ? (e.width - 1200) / 2 : 16,
		y: e.width >= 1280 ? 48 : 40,
		width: e.width >= 1280 ? 1200 : e.width - 32,
		height: e.width >= 1280 ? 704 : 688
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
function u(e, t, n, r, i = []) {
	let o = Math.min(16, n.width / 20), s = Math.max(o, Math.min(40, n.height / 5)), c = {
		x: r ? e + 24 < n.width / 2 ? o : Math.max(o, n.width - 48 - o) : a(e, o, n.width - 48 - o),
		y: a(t, o, n.height - 48 - s)
	}, l = i.filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.width) && Number.isFinite(e.height) && e.width > 0 && e.height > 0 && e.x < c.x + 56 && e.x + e.width + 8 > c.x).map((e) => ({
		start: e.y - 56,
		end: e.y + e.height + 8
	})).sort((e, t) => e.start - t.start), u = [];
	for (let e of l) {
		let t = u.at(-1);
		t && e.start < t.end ? t.end = Math.max(t.end, e.end) : u.push({ ...e });
	}
	let d = u.find((e) => c.y > e.start && c.y < e.end);
	if (!d) return c;
	let f = [d.start, d.end].filter((e) => e >= o && e <= n.height - 48 - s).sort((e, t) => Math.abs(e - c.y) - Math.abs(t - c.y) || e - t);
	return f[0] === void 0 ? c : {
		...c,
		y: f[0]
	};
}
//#endregion
//#region ../examples/browser-debugger/src/ball-obstacles.ts
var d = "[data-deviceforge-debugger]", f = "button,input:not([type=\"hidden\"]),select,textarea,a[href],summary,[role=\"button\"],[role=\"tab\"],[role=\"checkbox\"],[role=\"switch\"],[role=\"combobox\"],[contenteditable=\"true\"]";
function p(e, t) {
	let n = e.defaultView;
	if (!n) return [];
	let r = [];
	for (let i of e.querySelectorAll(f)) {
		if (i.closest(`${d},[hidden],[inert],[aria-hidden="true"]`)) continue;
		let e = i.getBoundingClientRect();
		if (e.width <= 0 || e.height <= 0 || e.right + 8 <= t || e.left >= t + 56 || e.bottom <= 0 || e.top >= n.innerHeight) continue;
		let a = n.getComputedStyle(i);
		a.visibility !== "hidden" && a.visibility !== "collapse" && a.display !== "none" && r.push({
			x: e.x,
			y: e.y,
			width: e.width,
			height: e.height
		});
	}
	return r;
}
function m(e, t) {
	let n = e.defaultView;
	if (!n) return () => {};
	let r = null, i = !1, a = () => {
		i || r !== null || (r = n.requestAnimationFrame(() => {
			r = null, i || t();
		}));
	}, o = new n.MutationObserver((e) => {
		e.some((e) => !(e.target instanceof n.Element && e.target.closest(d))) && a();
	});
	return o.observe(e.documentElement, {
		childList: !0,
		subtree: !0,
		attributes: !0,
		attributeFilter: [
			"class",
			"style",
			"hidden",
			"inert",
			"aria-hidden",
			"data-state"
		]
	}), e.addEventListener("scroll", a, !0), n.addEventListener("resize", a), a(), () => {
		i || (i = !0, o.disconnect(), e.removeEventListener("scroll", a, !0), n.removeEventListener("resize", a), r !== null && n.cancelAnimationFrame(r), r = null);
	};
}
//#endregion
//#region ../examples/browser-debugger/src/style.ts
var h = "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n@layer properties;\n@scope ([data-deviceforge-debugger]) {\n  .collapse {\n    visibility: collapse;\n  }\n  .visible {\n    visibility: visible;\n  }\n  .sr-only {\n    position: absolute;\n    width: 1px;\n    height: 1px;\n    padding: 0;\n    margin: -1px;\n    overflow: hidden;\n    clip-path: inset(50%);\n    white-space: nowrap;\n    border-width: 0;\n  }\n  .absolute {\n    position: absolute;\n  }\n  .fixed {\n    position: fixed;\n  }\n  .relative {\n    position: relative;\n  }\n  .sticky {\n    position: sticky;\n  }\n  .top-0 {\n    top: 0px;\n  }\n  .top-\\[var\\(--df-y\\)\\] {\n    top: var(--df-y);\n  }\n  .right-0 {\n    right: 0px;\n  }\n  .bottom-0 {\n    bottom: 0px;\n  }\n  .bottom-6 {\n    bottom: calc(0.25rem * 6);\n  }\n  .bottom-full {\n    bottom: 100%;\n  }\n  .left-0 {\n    left: 0px;\n  }\n  .left-1\\/2 {\n    left: calc(1 / 2 * 100%);\n  }\n  .left-\\[var\\(--df-x\\)\\] {\n    left: var(--df-x);\n  }\n  .z-10 {\n    z-index: 10;\n  }\n  .z-\\[2147483000\\] {\n    z-index: 2147483000;\n  }\n  .z-\\[2147483001\\] {\n    z-index: 2147483001;\n  }\n  .my-2 {\n    margin-block: calc(0.25rem * 2);\n  }\n  .mt-0\\.5 {\n    margin-top: calc(0.25rem * 0.5);\n  }\n  .mt-1 {\n    margin-top: 0.25rem;\n  }\n  .mt-2 {\n    margin-top: calc(0.25rem * 2);\n  }\n  .mt-3 {\n    margin-top: calc(0.25rem * 3);\n  }\n  .mt-4 {\n    margin-top: calc(0.25rem * 4);\n  }\n  .mr-2 {\n    margin-right: calc(0.25rem * 2);\n  }\n  .mr-auto {\n    margin-right: auto;\n  }\n  .mb-2 {\n    margin-bottom: calc(0.25rem * 2);\n  }\n  .mb-3 {\n    margin-bottom: calc(0.25rem * 3);\n  }\n  .mb-4 {\n    margin-bottom: calc(0.25rem * 4);\n  }\n  .block {\n    display: block;\n  }\n  .flex {\n    display: flex;\n  }\n  .grid {\n    display: grid;\n  }\n  .hidden {\n    display: none;\n  }\n  .inline-flex {\n    display: inline-flex;\n  }\n  .table {\n    display: table;\n  }\n  .size-4 {\n    width: calc(0.25rem * 4);\n    height: calc(0.25rem * 4);\n  }\n  .size-6 {\n    width: calc(0.25rem * 6);\n    height: calc(0.25rem * 6);\n  }\n  .size-7 {\n    width: calc(0.25rem * 7);\n    height: calc(0.25rem * 7);\n  }\n  .size-9 {\n    width: calc(0.25rem * 9);\n    height: calc(0.25rem * 9);\n  }\n  .size-12 {\n    width: calc(0.25rem * 12);\n    height: calc(0.25rem * 12);\n  }\n  .size-px {\n    width: 1px;\n    height: 1px;\n  }\n  .h-\\[var\\(--df-height\\)\\] {\n    height: var(--df-height);\n  }\n  .max-h-64 {\n    max-height: calc(0.25rem * 64);\n  }\n  .max-h-72 {\n    max-height: calc(0.25rem * 72);\n  }\n  .max-h-80 {\n    max-height: calc(0.25rem * 80);\n  }\n  .min-h-0 {\n    min-height: 0px;\n  }\n  .min-h-9 {\n    min-height: calc(0.25rem * 9);\n  }\n  .min-h-14 {\n    min-height: calc(0.25rem * 14);\n  }\n  .min-h-20 {\n    min-height: calc(0.25rem * 20);\n  }\n  .min-h-24 {\n    min-height: calc(0.25rem * 24);\n  }\n  .min-h-28 {\n    min-height: calc(0.25rem * 28);\n  }\n  .min-h-40 {\n    min-height: calc(0.25rem * 40);\n  }\n  .min-h-44 {\n    min-height: calc(0.25rem * 44);\n  }\n  .min-h-64 {\n    min-height: calc(0.25rem * 64);\n  }\n  .min-h-80 {\n    min-height: calc(0.25rem * 80);\n  }\n  .min-h-\\[72px\\] {\n    min-height: 72px;\n  }\n  .min-h-full {\n    min-height: 100%;\n  }\n  .w-\\[var\\(--df-width\\)\\] {\n    width: var(--df-width);\n  }\n  .w-full {\n    width: 100%;\n  }\n  .max-w-80 {\n    max-width: calc(0.25rem * 80);\n  }\n  .max-w-xl {\n    max-width: 36rem;\n  }\n  .min-w-0 {\n    min-width: 0px;\n  }\n  .min-w-32 {\n    min-width: calc(0.25rem * 32);\n  }\n  .min-w-36 {\n    min-width: calc(0.25rem * 36);\n  }\n  .min-w-40 {\n    min-width: calc(0.25rem * 40);\n  }\n  .flex-1 {\n    flex: 1;\n  }\n  .shrink-0 {\n    flex-shrink: 0;\n  }\n  .-translate-x-1\\/2 {\n    --tw-translate-x: calc(calc(1 / 2 * 100%) * -1);\n    translate: var(--tw-translate-x) var(--tw-translate-y);\n  }\n  .cursor-pointer {\n    cursor: pointer;\n  }\n  .cursor-se-resize {\n    cursor: se-resize;\n  }\n  .touch-none {\n    touch-action: none;\n  }\n  .resize {\n    resize: both;\n  }\n  .list-inside {\n    list-style-position: inside;\n  }\n  .list-disc {\n    list-style-type: disc;\n  }\n  .grid-cols-1 {\n    grid-template-columns: repeat(1, minmax(0, 1fr));\n  }\n  .grid-cols-2 {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n  .grid-cols-\\[100px_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: 100px minmax(0,1fr);\n  }\n  .grid-cols-\\[224px_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: 224px minmax(0,1fr);\n  }\n  .grid-cols-\\[minmax\\(0\\,1\\.4fr\\)_minmax\\(230px\\,1fr\\)\\] {\n    grid-template-columns: minmax(0,1.4fr) minmax(230px,1fr);\n  }\n  .grid-cols-\\[minmax\\(0\\,1\\.66fr\\)_minmax\\(280px\\,1fr\\)\\] {\n    grid-template-columns: minmax(0,1.66fr) minmax(280px,1fr);\n  }\n  .grid-cols-\\[minmax\\(190px\\,28\\%\\)_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: minmax(190px,28%) minmax(0,1fr);\n  }\n  .flex-col {\n    flex-direction: column;\n  }\n  .flex-wrap {\n    flex-wrap: wrap;\n  }\n  .items-center {\n    align-items: center;\n  }\n  .items-start {\n    align-items: flex-start;\n  }\n  .justify-center {\n    justify-content: center;\n  }\n  .gap-1 {\n    gap: 0.25rem;\n  }\n  .gap-2 {\n    gap: calc(0.25rem * 2);\n  }\n  .gap-3 {\n    gap: calc(0.25rem * 3);\n  }\n  .gap-4 {\n    gap: calc(0.25rem * 4);\n  }\n  .gap-6 {\n    gap: calc(0.25rem * 6);\n  }\n  .space-y-1 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(0.25rem * var(--tw-space-y-reverse));\n      margin-block-end: calc(0.25rem * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-2 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 2) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 2) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-3 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 3) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 3) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-4 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 4) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 4) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .space-y-5 {\n    :where(& > :not(:last-child)) {\n      --tw-space-y-reverse: 0;\n      margin-block-start: calc(calc(0.25rem * 5) * var(--tw-space-y-reverse));\n      margin-block-end: calc(calc(0.25rem * 5) * calc(1 - var(--tw-space-y-reverse)));\n    }\n  }\n  .truncate {\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n  }\n  .overflow-auto {\n    overflow: auto;\n  }\n  .overflow-hidden {\n    overflow: hidden;\n  }\n  .rounded {\n    border-radius: 0.25rem;\n  }\n  .rounded-2xl {\n    border-radius: 1rem;\n  }\n  .rounded-full {\n    border-radius: calc(infinity * 1px);\n  }\n  .rounded-lg {\n    border-radius: 0.5rem;\n  }\n  .rounded-md {\n    border-radius: 0.375rem;\n  }\n  .rounded-xl {\n    border-radius: 0.75rem;\n  }\n  .rounded-br-xl {\n    border-bottom-right-radius: 0.75rem;\n  }\n  .border {\n    border-style: var(--tw-border-style);\n    border-width: 1px;\n  }\n  .border-t {\n    border-top-style: var(--tw-border-style);\n    border-top-width: 1px;\n  }\n  .border-b {\n    border-bottom-style: var(--tw-border-style);\n    border-bottom-width: 1px;\n  }\n  .border-dashed {\n    --tw-border-style: dashed;\n    border-style: dashed;\n  }\n  .border-\\[\\#6C4CF5\\] {\n    border-color: #6C4CF5;\n  }\n  .border-\\[\\#7A879B\\] {\n    border-color: #7A879B;\n  }\n  .border-\\[\\#E6EAF3\\] {\n    border-color: #E6EAF3;\n  }\n  .border-transparent {\n    border-color: transparent;\n  }\n  .border-white {\n    border-color: #fff;\n  }\n  .bg-\\[\\#6C4CF5\\] {\n    background-color: #6C4CF5;\n  }\n  .bg-\\[\\#EAF8F0\\] {\n    background-color: #EAF8F0;\n  }\n  .bg-\\[\\#EFEBFF\\] {\n    background-color: #EFEBFF;\n  }\n  .bg-\\[\\#F7F8FC\\] {\n    background-color: #F7F8FC;\n  }\n  .bg-\\[\\#FBFCFE\\] {\n    background-color: #FBFCFE;\n  }\n  .bg-\\[\\#FDF6ED\\] {\n    background-color: #FDF6ED;\n  }\n  .bg-white {\n    background-color: #fff;\n  }\n  .p-2 {\n    padding: calc(0.25rem * 2);\n  }\n  .p-3 {\n    padding: calc(0.25rem * 3);\n  }\n  .p-4 {\n    padding: calc(0.25rem * 4);\n  }\n  .p-5 {\n    padding: calc(0.25rem * 5);\n  }\n  .p-6 {\n    padding: calc(0.25rem * 6);\n  }\n  .px-1\\.5 {\n    padding-inline: calc(0.25rem * 1.5);\n  }\n  .px-2 {\n    padding-inline: calc(0.25rem * 2);\n  }\n  .px-3 {\n    padding-inline: calc(0.25rem * 3);\n  }\n  .px-4 {\n    padding-inline: calc(0.25rem * 4);\n  }\n  .px-5 {\n    padding-inline: calc(0.25rem * 5);\n  }\n  .px-6 {\n    padding-inline: calc(0.25rem * 6);\n  }\n  .py-0\\.5 {\n    padding-block: calc(0.25rem * 0.5);\n  }\n  .py-1\\.5 {\n    padding-block: calc(0.25rem * 1.5);\n  }\n  .py-2 {\n    padding-block: calc(0.25rem * 2);\n  }\n  .py-3 {\n    padding-block: calc(0.25rem * 3);\n  }\n  .py-4 {\n    padding-block: calc(0.25rem * 4);\n  }\n  .pr-2 {\n    padding-right: calc(0.25rem * 2);\n  }\n  .pr-10 {\n    padding-right: calc(0.25rem * 10);\n  }\n  .pl-\\[var\\(--df-depth\\)\\] {\n    padding-left: var(--df-depth);\n  }\n  .text-center {\n    text-align: center;\n  }\n  .text-left {\n    text-align: left;\n  }\n  .font-mono {\n    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',\n    monospace;\n  }\n  .font-sans {\n    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial,\n    sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';\n  }\n  .text-lg {\n    font-size: 1.125rem;\n    line-height: var(--tw-leading, calc(1.75 / 1.125));\n  }\n  .text-sm {\n    font-size: 0.875rem;\n    line-height: var(--tw-leading, calc(1.25 / 0.875));\n  }\n  .text-xs {\n    font-size: 0.75rem;\n    line-height: var(--tw-leading, calc(1 / 0.75));\n  }\n  .text-\\[13px\\] {\n    font-size: 13px;\n  }\n  .text-\\[15px\\] {\n    font-size: 15px;\n  }\n  .text-\\[18px\\] {\n    font-size: 18px;\n  }\n  .leading-relaxed {\n    --tw-leading: 1.625;\n    line-height: 1.625;\n  }\n  .font-medium {\n    --tw-font-weight: 500;\n    font-weight: 500;\n  }\n  .font-semibold {\n    --tw-font-weight: 600;\n    font-weight: 600;\n  }\n  .break-words {\n    overflow-wrap: break-word;\n  }\n  .break-all {\n    word-break: break-all;\n  }\n  .whitespace-pre-wrap {\n    white-space: pre-wrap;\n  }\n  .text-\\[\\#6C4CF5\\] {\n    color: #6C4CF5;\n  }\n  .text-\\[\\#8A4D00\\] {\n    color: #8A4D00;\n  }\n  .text-\\[\\#17664F\\] {\n    color: #17664F;\n  }\n  .text-\\[\\#23272E\\] {\n    color: #23272E;\n  }\n  .text-\\[\\#556176\\] {\n    color: #556176;\n  }\n  .text-white {\n    color: #fff;\n  }\n  .accent-\\[\\#6C4CF5\\] {\n    accent-color: #6C4CF5;\n  }\n  .opacity-0 {\n    opacity: 0%;\n  }\n  .shadow-2xl {\n    --tw-shadow: 0 25px 50px -12px var(--tw-shadow-color, rgb(0 0 0 / 0.25));\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n  .shadow-lg {\n    --tw-shadow: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n  .outline-none {\n    --tw-outline-style: none;\n    outline-style: none;\n  }\n  .select-none {\n    -webkit-user-select: none;\n    user-select: none;\n  }\n  .hover\\:bg-\\[\\#5835DA\\] {\n    &:hover {\n      @media (hover: hover) {\n        background-color: #5835DA;\n      }\n    }\n  }\n  .hover\\:bg-\\[\\#F7F8FC\\] {\n    &:hover {\n      @media (hover: hover) {\n        background-color: #F7F8FC;\n      }\n    }\n  }\n  .focus-visible\\:ring-2 {\n    &:focus-visible {\n      --tw-ring-shadow: var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);\n      box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n    }\n  }\n  .focus-visible\\:ring-\\[\\#6C4CF5\\] {\n    &:focus-visible {\n      --tw-ring-color: #6C4CF5;\n    }\n  }\n  .focus-visible\\:ring-offset-2 {\n    &:focus-visible {\n      --tw-ring-offset-width: 2px;\n      --tw-ring-offset-shadow: var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);\n    }\n  }\n  .disabled\\:cursor-not-allowed {\n    &:disabled {\n      cursor: not-allowed;\n    }\n  }\n  .disabled\\:opacity-50 {\n    &:disabled {\n      opacity: 50%;\n    }\n  }\n  .disabled\\:opacity-60 {\n    &:disabled {\n      opacity: 60%;\n    }\n  }\n  .max-\\[700px\\]\\:grid-cols-1 {\n    @media (width < 700px) {\n      grid-template-columns: repeat(1, minmax(0, 1fr));\n    }\n  }\n}\n@property --tw-translate-x {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n@property --tw-translate-y {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n@property --tw-translate-z {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n@property --tw-space-y-reverse {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n@property --tw-border-style {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: solid;\n}\n@property --tw-leading {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-font-weight {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-shadow-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n@property --tw-inset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-inset-shadow-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-inset-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n@property --tw-ring-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-inset-ring-color {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-inset-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@property --tw-ring-inset {\n  syntax: \"*\";\n  inherits: false;\n}\n@property --tw-ring-offset-width {\n  syntax: \"<length>\";\n  inherits: false;\n  initial-value: 0px;\n}\n@property --tw-ring-offset-color {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: #fff;\n}\n@property --tw-ring-offset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n@layer properties {\n  @supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color:rgb(from red r g b)))) {\n    *, ::before, ::after, ::backdrop {\n      --tw-translate-x: 0;\n      --tw-translate-y: 0;\n      --tw-translate-z: 0;\n      --tw-space-y-reverse: 0;\n      --tw-border-style: solid;\n      --tw-leading: initial;\n      --tw-font-weight: initial;\n      --tw-shadow: 0 0 #0000;\n      --tw-shadow-color: initial;\n      --tw-shadow-alpha: 100%;\n      --tw-inset-shadow: 0 0 #0000;\n      --tw-inset-shadow-color: initial;\n      --tw-inset-shadow-alpha: 100%;\n      --tw-ring-color: initial;\n      --tw-ring-shadow: 0 0 #0000;\n      --tw-inset-ring-color: initial;\n      --tw-inset-ring-shadow: 0 0 #0000;\n      --tw-ring-inset: initial;\n      --tw-ring-offset-width: 0px;\n      --tw-ring-offset-color: #fff;\n      --tw-ring-offset-shadow: 0 0 #0000;\n    }\n  }\n}\n";
//#endregion
//#region ../examples/browser-debugger/src/protocol.ts
function g(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function _(e) {
	return g(e) ? e : {};
}
function v(e) {
	return Array.isArray(e) ? e : [];
}
function y(e, t = "") {
	return typeof e == "string" ? e : t;
}
function b(e, t = 0) {
	return typeof e == "number" && Number.isFinite(e) ? e : t;
}
function x(e, t = 0) {
	if (t > 48) throw Error("JSON 嵌套超过 48 层");
	if (e === null || typeof e == "string" || typeof e == "boolean" || typeof e == "number" && Number.isFinite(e)) return e;
	if (Array.isArray(e)) return e.map((e) => x(e, t + 1));
	if (g(e)) return Object.fromEntries(Object.entries(e).map(([e, n]) => [e, x(n, t + 1)]));
	throw Error("参数必须是有限 JSON");
}
function S(e) {
	if (new TextEncoder().encode(e).length > 131072) throw Error("JSON 输入不能超过 128 KiB");
	return x(JSON.parse(e));
}
var C = class extends Error {
	code;
	logId;
	unconfirmed;
	constructor(e, t, n = null, r = !1) {
		super(e), this.name = "DebuggerFailure", this.code = t, this.logId = n, this.unconfirmed = r;
	}
};
function w(e) {
	if (e instanceof C) return e;
	let t = _(e);
	return new C(e instanceof Error ? e.message : "调试请求失败", y(t.code, "debugger_failed"), y(t.logId) || null, /unconfirmed|timeout|cancel/i.test(y(t.code)));
}
function T(e, t) {
	return new Promise((n, r) => {
		let i = () => r(new C("等待已取消或到期；已派发动作的结果需要核对，不会自动重放", "debugger_wait_unconfirmed", null, !0));
		t.aborted ? (e.catch(() => void 0), i()) : (t.addEventListener("abort", i, { once: !0 }), e.then(n, r).finally(() => t.removeEventListener("abort", i)));
	});
}
var E = (e) => JSON.stringify([
	e.kind,
	e.instanceId,
	e.pluginId,
	e.generation
]);
function D(e) {
	return {
		target_kind: e.kind,
		instance_id: e.instanceId,
		plugin_id: e.pluginId,
		generation: e.generation,
		version: e.version
	};
}
function O(e, t = null) {
	let n = _(e), r = y(n.plugin_id);
	return r ? {
		kind: n.target_kind === "server" ? "server" : "browser",
		instanceId: y(n.instance_id) || t,
		pluginId: r,
		generation: y(n.generation) || null,
		version: y(n.version) || null
	} : null;
}
function k(e) {
	let t = _(e), n = [];
	for (let e of v(t.browser_targets)) {
		let t = O(e);
		t && n.push(t);
	}
	for (let e of v(t.browser_instances)) {
		let t = _(e);
		for (let e of v(t.plugins)) {
			let r = O(e, y(t.instance_id) || null);
			r && n.push(r);
		}
	}
	for (let e of v(t.server_plugins)) {
		let t = _(e), r = y(t.id);
		r && n.push({
			kind: "server",
			instanceId: null,
			pluginId: r,
			generation: y(t.generation) || null,
			version: y(t.version) || null
		});
	}
	return [...new Map(n.map((e) => [E(e), e])).values()];
}
function A(e) {
	let t = _(e);
	if (!y(t.id) || !Array.isArray(t.nodes)) return null;
	let n = [];
	for (let e of t.nodes) {
		let t = _(e);
		if (!y(t.id) || !Number.isSafeInteger(t.generation) || !Number.isSafeInteger(t.revision)) throw Error("UI 节点缺少有效的标识、代次或修订");
		let r = x(t);
		if (!j(r)) throw Error("UI 节点不是对象");
		n.push({
			id: y(t.id),
			generation: b(t.generation),
			revision: b(t.revision),
			parentId: y(t.parentId) || null,
			name: y(t.name),
			role: y(t.role),
			raw: r
		});
	}
	return {
		id: y(t.id),
		observedAt: b(t.observedAt),
		nodes: n,
		raw: x(t)
	};
}
function j(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function M(e) {
	let t = _(e), n = y(t.id), r = y(t.tool);
	return !n || !r ? null : {
		id: n,
		tool: r,
		label: y(t.label) || null
	};
}
function N(e) {
	let t = _(e), n = y(t.command_id), r = y(t.tool);
	if (!n || !r || !Number.isSafeInteger(t.sequence)) return null;
	let i = v(t.steps).map(M).filter((e) => e !== null);
	return {
		sequence: Number(t.sequence),
		commandId: n,
		tool: r,
		state: y(t.state, "unknown"),
		steps: i,
		response: t.response === null || t.response === void 0 ? null : x(t.response)
	};
}
function P(e, t) {
	let n = _(e), r = O(n.target);
	if (!r || t && E(r) !== E(t)) throw Error("调试调用回执不属于当前明确目标");
	return {
		target: r,
		items: v(n.items).map(N).filter((e) => e !== null),
		nextBefore: n.next_before === null || n.next_before === void 0 ? null : b(n.next_before),
		gap: n.gap === !0,
		retainedOnly: n.retained_only === !0,
		...y(n.unavailable) ? { unavailable: y(n.unavailable) } : {}
	};
}
function F(e) {
	return e === "immediate" || e === "next_invocation" || e === "reload" ? e : null;
}
function I(e) {
	return e === "memory" || e === "persistent" ? e : null;
}
function L(e) {
	return v(_(e).sources).map((e) => {
		let t = _(e), n = y(t.id), r = y(t.label, n);
		return n ? {
			id: n,
			label: r,
			schema: x(t.schema ?? null),
			schemaComplete: t.schema_complete !== !1,
			omittedSchemaPaths: v(t.omitted_schema_paths).map((e) => y(e)).filter(Boolean),
			writable: t.writable === !0,
			persistence: I(t.persistence),
			applyPolicy: F(t.apply_policy)
		} : null;
	}).filter((e) => e !== null);
}
function R(e, t) {
	let n = _(e), r = y(n.revision), i = y(n.source_id, t);
	return !r || !i || n.value === void 0 ? null : {
		sourceId: i,
		revision: r,
		value: x(n.value),
		writable: n.writable === !0,
		applyPolicy: F(n.apply_policy),
		runtimeApplied: n.runtime_applied === "declared" || n.runtime_applied === "pending" ? n.runtime_applied : null
	};
}
function z(e) {
	let t = _(e), n = _(t.catalog), r = [];
	for (let e of v(n.commands)) {
		let t = y(_(e).id);
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
	for (let e of [...v(n.services), ...v(t.services)]) {
		let t = _(e), n = _(t.service), i = _(t.contract), a = y(t.id) || y(n.id), o = y(t.version) || y(n.version);
		a && o && r.push({
			key: `service:${a}:${o}`,
			kind: "service",
			id: a,
			version: o,
			schema: x(t.inputSchema ?? i.input_schema ?? i.inputSchema ?? null),
			available: t.available !== !1,
			reason: y(t.reason)
		});
	}
	for (let e of v(t.operations)) {
		let t = _(e), n = y(t.id);
		n && r.push({
			key: `operation:${n}`,
			kind: "operation",
			id: n,
			version: null,
			schema: x(t.input_schema ?? null),
			available: !0,
			reason: "服务器操作沿原任务入口执行，返回原任务 ID"
		});
	}
	return r;
}
function B(e) {
	async function t(t, n, r, i = 15e3) {
		let a = e.extensions;
		if (!a) throw new C("宿主未提供公开扩展服务，请升级宿主", "service_unavailable");
		let o = AbortSignal.any([
			e.signal,
			r,
			AbortSignal.timeout(i)
		]);
		o.throwIfAborted();
		let s = await T(a.callService("host.debugger", "1", {
			action: t,
			...n
		}, o), o);
		return o.throwIfAborted(), s;
	}
	async function n(e, n, r, i = 15e3) {
		let a = await t("call", {
			name: `deviceforge.debug_${e}`,
			input: n
		}, r, i), o = _(a.data);
		if (typeof o.state == "string" && o.state.endsWith("_unconfirmed")) throw new C(y(_(_(o.response).error).message, "命令等待结束，真实结果未确认；请查询目标状态，不会自动重试"), y(_(_(o.response).error).code, o.state), a.logId, !0);
		if (typeof o.command_id == "string") {
			let e = y(o.state);
			if (e !== "succeeded") {
				let t = _(_(o.response).error);
				throw new C(y(t.message, `命令状态：${e || "未知"}；没有确认成功，不会自动重试`), y(t.code, e || "result_unconfirmed"), a.logId, e !== "failed");
			}
			if (o.response === void 0) throw new C("成功回执缺少 response", "invalid_receipt", a.logId);
			return {
				data: x(o.response),
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
function V(e, t) {
	let n = new Map(t.map((e) => [e.id, e])), r = /* @__PURE__ */ new Set([e.id]), i = e.parentId, a = 0;
	for (; i && a < 32 && !r.has(i);) r.add(i), a++, i = n.get(i)?.parentId ?? null;
	return a;
}
function H(e, t, n, r) {
	let i = new Map(e.map((e) => [e.id, e])), a = e.filter((e) => (!t.name || `${e.name} ${e.id}`.toLocaleLowerCase().includes(t.name.toLocaleLowerCase())) && (!t.role || e.role === t.role) && (!t.hidden || y(e.raw.hidden) === t.hidden) && (!t.disabled || y(e.raw.disabled) === t.disabled) && (!r || r.includes(e.id))), o = !!(t.name || t.role || t.hidden || t.disabled || r), s = new Set(a.map((e) => e.id));
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
var U = "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50";
function W({ children: e, primary: t = !1, soft: n = !1, ...i }) {
	return /* @__PURE__ */ r("button", {
		type: "button",
		...i,
		className: `${t ? "border-[#6C4CF5] bg-[#6C4CF5] text-white hover:bg-[#5835DA]" : n ? "border-transparent bg-[#EFEBFF] text-[#6C4CF5] hover:bg-[#F7F8FC]" : "border-[#E6EAF3] bg-white text-[#23272E] hover:bg-[#F7F8FC]"} min-h-9 shrink-0 rounded-lg border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 ${i.className ?? ""}`,
		children: e
	});
}
function G({ children: e, warning: t = !1 }) {
	return /* @__PURE__ */ r("span", {
		className: `${t ? "bg-[#FDF6ED] text-[#8A4D00]" : "bg-[#EFEBFF] text-[#6C4CF5]"} inline-flex rounded px-1.5 py-0.5 text-xs`,
		children: e
	});
}
function K({ checked: e, onChange: t, children: n, disabled: a = !1 }) {
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
function q({ value: e, label: t = "查看辅助 JSON" }) {
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
function J({ title: e, children: t }) {
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
function Y({ label: e, children: t }) {
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
async function ee(e, t) {
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
function X({ value: t, label: n = "复制日志 ID" }) {
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
			/* @__PURE__ */ r(W, {
				onClick: () => {
					let e = s.current?.ownerDocument;
					e && ee(t, e).then(() => o("已复制"), (e) => o(e instanceof Error ? e.message : "复制失败"));
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
function te({ value: e }) {
	if (e === null) return null;
	let t = _(e), a = _(t.result_metadata), o = _(t.artifact), s = y(t.status) || y(t.state), c = _(t.host), l = _(t.owner);
	return /* @__PURE__ */ i("section", {
		"aria-label": "最近操作结果",
		className: "space-y-3 rounded-lg border border-[#E6EAF3] bg-[#FBFCFE] p-3",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ r("h3", {
					className: "text-sm font-medium",
					children: "最近操作结果"
				}), s && /* @__PURE__ */ r(G, {
					warning: /failed|rejected|indeterminate|unconfirmed/.test(s),
					children: s
				})]
			}),
			y(t.reason) && /* @__PURE__ */ r("p", {
				className: "text-[13px] text-[#556176]",
				children: y(t.reason)
			}),
			t.source === "host-dom" && /* @__PURE__ */ i(n, { children: [
				/* @__PURE__ */ r("h4", {
					className: "text-sm font-medium",
					children: "宿主节点 · 只读身份"
				}),
				/* @__PURE__ */ i("dl", { children: [
					/* @__PURE__ */ r(Y, {
						label: "名称",
						children: y(c.label, "未提供")
					}),
					/* @__PURE__ */ i(Y, {
						label: "标签 / 角色",
						children: [
							y(c.tag),
							" · ",
							y(c.role, "未提供")
						]
					}),
					/* @__PURE__ */ r(Y, {
						label: "插入能力",
						children: "此普通节点不可插入"
					}),
					/* @__PURE__ */ r(Y, {
						label: "最近公开槽位",
						children: typeof c.nearest_slot == "string" ? c.nearest_slot : y(_(c.nearest_slot).id, "未观测到真实公开祖先槽位")
					}),
					/* @__PURE__ */ r(Y, {
						label: "所在路由",
						children: typeof c.route == "string" ? c.route : y(_(c.route).path, "未提供")
					})
				] }),
				/* @__PURE__ */ r("p", {
					className: "text-[13px] text-[#556176]",
					children: "该身份没有插件节点引用，不能点击、填值或作为插件动作目标。"
				})
			] }),
			y(l.pluginId) && /* @__PURE__ */ i("p", {
				className: "break-all text-[13px]",
				children: [
					"拾取归属：",
					/* @__PURE__ */ r("code", { children: y(l.pluginId) }),
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
					/* @__PURE__ */ i("span", { children: ["新增 ", v(t.added).length] }),
					/* @__PURE__ */ i("span", { children: ["移除 ", v(t.removed).length] }),
					/* @__PURE__ */ i("span", { children: ["变更 ", v(t.changed).length] })
				]
			}),
			y(t.job_id) && /* @__PURE__ */ i("dl", { children: [/* @__PURE__ */ r(Y, {
				label: "原任务 ID",
				children: /* @__PURE__ */ r("code", { children: y(t.job_id) })
			}), /* @__PURE__ */ r(Y, {
				label: "任务状态",
				children: y(t.status, "请沿原任务入口查询")
			})] }),
			a.included === !1 && /* @__PURE__ */ i("p", {
				className: "text-[13px] text-[#556176]",
				children: [
					"结果正文未收集：",
					y(a.type),
					"，",
					String(a.bytes ?? "未知"),
					" 字节。"
				]
			}),
			t.businessOutcome === "unknown" && /* @__PURE__ */ r("p", {
				className: "text-[13px] text-[#8A4D00]",
				children: "业务结果未知；合成事件派发不代表设备或业务操作成功。"
			}),
			y(o.id) && /* @__PURE__ */ i("p", {
				className: "text-[13px]",
				children: ["报告产物：", /* @__PURE__ */ r("code", { children: y(o.id) })]
			}),
			/* @__PURE__ */ r(q, { value: e })
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/tree-view.tsx
var ne = (e) => e === "yes" ? "是" : e === "no" ? "否" : "未知";
function re({ state: t, controller: a }) {
	let [o, s] = e.useState(""), [c, l] = e.useState(""), [u, d] = e.useState(""), [f, p] = e.useState(""), [m, h] = e.useState(/* @__PURE__ */ new Set()), [g, b] = e.useState(!1), [x, C] = e.useState(!1), [w, T] = e.useState(""), [E, D] = e.useState("click"), [O, k] = e.useState("{\"query\":{\"role\":\"button\"},\"condition\":\"exists\"}"), [A, j] = e.useState(""), [M, N] = e.useState(""), [P, F] = e.useState(""), I = t.tree?.nodes ?? [], L = H(I, {
		name: o,
		role: c,
		hidden: u,
		disabled: f
	}, m, t.queries), R = I.find((e) => e.id === t.selectedNodeId), z = t.stale || !t.connected || !t.sessionId || !!t.busy, B = _(_(t.inspection).capabilities), ee = e.useRef(null);
	e.useEffect(() => {
		let e = ee.current, t = e?.querySelector("[aria-selected=\"true\"]");
		if (!e || !t) return;
		let n = e.getBoundingClientRect(), r = t.getBoundingClientRect();
		r.top < n.top ? e.scrollTop -= n.top - r.top : r.bottom > n.bottom && (e.scrollTop += r.bottom - n.bottom);
	}, [t.selectedNodeId, t.tree?.id]), e.useEffect(() => {
		b(!1), C(!1), T("");
	}, [
		t.selectedNodeId,
		t.rootId,
		t.sessionId
	]);
	function X(e) {
		h((t) => {
			let n = new Set(t);
			return n.has(e.id) ? n.delete(e.id) : n.add(e.id), n;
		});
	}
	function re(e, t) {
		try {
			let n = S(e);
			F(""), t(n);
		} catch (e) {
			F(e instanceof Error ? e.message : "JSON 无效");
		}
	}
	let Z = _(_(t.tree?.raw).page), ie = _(_(t.tree?.raw).coverage);
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
							className: U,
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
					/* @__PURE__ */ r(W, {
						disabled: z || t.roots.length > 1 && !t.rootId,
						onClick: () => void a.tree(),
						children: "读取新快照"
					}),
					/* @__PURE__ */ r(W, {
						disabled: z || B.pick === !1,
						title: B.pick === !1 ? "宿主未提供公开拾取能力" : "点击插件节点；Esc 取消",
						onClick: () => void a.action("pick", null, "", !1, !1),
						children: "拾取节点"
					}),
					/* @__PURE__ */ r(W, {
						disabled: z,
						onClick: () => void a.overview(),
						children: "公开槽位与路由"
					}),
					t.tree && /* @__PURE__ */ r(G, {
						warning: t.stale,
						children: t.stale ? "已过期 · 只读" : "只读观测快照"
					})
				]
			}),
			/* @__PURE__ */ r("p", {
				className: "rounded-md bg-[#F7F8FC] px-3 py-2 text-[13px] text-[#556176]",
				children: "可观测节点不等于公开插入槽位。隐藏、遮挡和虚拟内容可能未知；不完整采集不能证明节点不存在。"
			}),
			t.target?.kind === "server" ? /* @__PURE__ */ r(J, {
				title: "服务器目标不提供浏览器 UI 树",
				children: "可以检查公开服务、查询事件和服务器日志，试调用仍沿原任务执行。"
			}) : t.tree ? /* @__PURE__ */ i("div", {
				className: "grid min-h-80 flex-1 grid-cols-[minmax(190px,28%)_minmax(0,1fr)] gap-4 max-[700px]:grid-cols-1",
				children: [/* @__PURE__ */ i("section", {
					"aria-label": "UI 结构树",
					className: "flex min-h-0 flex-col rounded-lg border border-[#E6EAF3]",
					children: [
						/* @__PURE__ */ i("div", {
							className: "space-y-2 border-b border-[#E6EAF3] p-3",
							children: [/* @__PURE__ */ r("input", {
								className: `${U} w-full`,
								placeholder: "搜索名称或节点 ID",
								"aria-label": "搜索节点",
								value: o,
								onChange: (e) => s(e.currentTarget.value)
							}), /* @__PURE__ */ i("details", {
								className: "text-[13px] text-[#556176]",
								children: [
									/* @__PURE__ */ r("summary", {
										className: "cursor-pointer",
										children: "高级筛选与语义查询"
									}),
									/* @__PURE__ */ i("div", {
										className: "mt-2 grid grid-cols-2 gap-2",
										children: [/* @__PURE__ */ i("select", {
											"aria-label": "语义角色",
											className: U,
											value: c,
											onChange: (e) => l(e.currentTarget.value),
											children: [/* @__PURE__ */ r("option", {
												value: "",
												children: "全部角色"
											}), [...new Set(I.map((e) => e.role))].filter(Boolean).map((e) => /* @__PURE__ */ r("option", { children: e }, e))]
										}), /* @__PURE__ */ i("select", {
											"aria-label": "隐藏状态",
											className: U,
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
										className: `${U} w-full`,
										value: f,
										onChange: (e) => p(e.currentTarget.value),
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
										children: [/* @__PURE__ */ r(W, {
											disabled: z,
											onClick: () => void a.query({
												...o ? { name: o } : {},
												...c ? { role: c } : {},
												...u ? { hidden: u } : {},
												...f ? { disabled: f } : {},
												limit: 500
											}),
											children: "按语义查询"
										}), t.queries && /* @__PURE__ */ r(W, {
											onClick: () => a.clearQuery(),
											children: "清除查询"
										})]
									})
								]
							})]
						}),
						/* @__PURE__ */ i("ul", {
							ref: ee,
							role: "tree",
							"aria-label": "已观测节点",
							className: "min-h-44 flex-1 overflow-auto p-2",
							children: [L.map((e, n) => {
								let o = I.some((t) => t.parentId === e.id), s = { "--df-depth": `${8 + V(e, I) * 14}px` };
								return /* @__PURE__ */ i("li", {
									role: "none",
									className: "flex items-center",
									children: [o && /* @__PURE__ */ r("button", {
										type: "button",
										"aria-label": `${m.has(e.id) ? "展开" : "折叠"} ${e.name || e.role}`,
										className: "size-6 shrink-0 rounded text-[#556176] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
										onClick: () => X(e),
										children: m.has(e.id) ? "▸" : "▾"
									}), /* @__PURE__ */ i("button", {
										type: "button",
										role: "treeitem",
										"aria-selected": e.id === t.selectedNodeId,
										"aria-level": V(e, I) + 1,
										"aria-expanded": o ? !m.has(e.id) : void 0,
										style: s,
										className: `${e.id === t.selectedNodeId ? "bg-[#EFEBFF] text-[#6C4CF5]" : "text-[#23272E] hover:bg-[#F7F8FC]"} min-h-9 min-w-0 flex-1 rounded py-2 pr-2 pl-[var(--df-depth)] text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`,
										title: `${e.role} · ${e.name}\n${e.id}`,
										onClick: () => a.setNode(e.id),
										onKeyDown: (t) => {
											let r = t.key === "ArrowDown" ? 1 : t.key === "ArrowUp" ? -1 : 0, i = L[n + r];
											r && i && (t.preventDefault(), a.setNode(i.id), (t.currentTarget.closest("[role=tree]")?.querySelectorAll("[role=treeitem]"))?.[n + r]?.focus()), (t.key === "ArrowLeft" || t.key === "ArrowRight") && o && (t.preventDefault(), h((n) => {
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
							}), !L.length && /* @__PURE__ */ r("li", {
								className: "p-3 text-[13px] text-[#556176]",
								children: "当前页没有匹配节点。"
							})]
						}),
						/* @__PURE__ */ i("div", {
							className: "border-t border-[#E6EAF3] p-2 text-xs text-[#556176]",
							children: [
								"已加载 ",
								I.length,
								" / ",
								typeof Z.total == "number" ? Z.total : I.length,
								" 节点",
								typeof Z.nextOffset == "number" && /* @__PURE__ */ r(W, {
									disabled: z,
									onClick: () => void a.nextTreePage(),
									children: "加载下一页"
								})
							]
						})
					]
				}), /* @__PURE__ */ i("section", {
					"aria-label": "节点详情",
					className: "min-h-0 space-y-3 overflow-auto rounded-lg border border-[#E6EAF3] p-4",
					children: [R ? /* @__PURE__ */ i(n, { children: [
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [
								/* @__PURE__ */ r("h3", {
									className: "text-[15px] font-semibold",
									children: R.name || R.role
								}),
								/* @__PURE__ */ r(G, { children: y(R.raw.kind, "节点") }),
								t.stale && /* @__PURE__ */ r(G, {
									warning: !0,
									children: "当时观测 · 已过期"
								})
							]
						}),
						/* @__PURE__ */ i("dl", { children: [
							/* @__PURE__ */ r(Y, {
								label: "节点 ID",
								children: /* @__PURE__ */ r("code", { children: R.id })
							}),
							/* @__PURE__ */ r(Y, {
								label: "节点引用",
								children: /* @__PURE__ */ i("code", { children: [
									"g",
									R.generation,
									" / r",
									R.revision
								] })
							}),
							/* @__PURE__ */ r(Y, {
								label: "所属表面",
								children: /* @__PURE__ */ r("code", { children: y(R.raw.surfaceId, "未提供") })
							}),
							/* @__PURE__ */ r(Y, {
								label: "语义角色",
								children: R.role || "未提供"
							}),
							/* @__PURE__ */ i(Y, {
								label: "状态证据",
								children: [
									"隐藏 ",
									ne(R.raw.hidden),
									" · 禁用 ",
									ne(R.raw.disabled),
									" · 可见 ",
									ne(R.raw.visible)
								]
							}),
							/* @__PURE__ */ i(Y, {
								label: "动作约束",
								children: [
									y(R.raw.actionPolicy, "unknown"),
									" · ",
									R.raw.confirmationRequired ? "需要原操作确认" : "仍需本次显式动作"
								]
							}),
							/* @__PURE__ */ r(Y, {
								label: "插入能力",
								children: "仅公开槽位可接入；此节点不授予插入权限"
							})
						] }),
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap gap-2",
							children: [/* @__PURE__ */ r(W, {
								disabled: z,
								onClick: () => void a.action("highlight", R, "", !1, !1),
								children: "临时高亮"
							}), /* @__PURE__ */ r(G, {
								warning: R.raw.opaque === !0,
								children: R.raw.opaque ? "不透明内容" : "仅观测 DOM"
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
									className: U,
									value: E,
									onChange: (e) => {
										D(e.currentTarget.value), b(!1), C(!1);
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
										T(e.currentTarget.value), b(!1), C(!1);
									},
									placeholder: E === "select" ? "每行一个选项值" : "原生输入框的新值"
								}),
								/* @__PURE__ */ r(K, {
									disabled: t.stale,
									checked: g,
									onChange: b,
									children: "确认对此节点执行本次动作"
								}),
								/* @__PURE__ */ r(K, {
									disabled: t.stale,
									checked: x,
									onChange: C,
									children: "允许未知副作用，可能间接影响设备或外部资源"
								}),
								/* @__PURE__ */ r(W, {
									disabled: z || !g || !x,
									primary: !0,
									onClick: () => {
										a.action(E, R, w, g, x), b(!1), C(!1);
									},
									children: "执行一次"
								})
							]
						}),
						/* @__PURE__ */ r(q, {
							value: R.raw.layout ?? null,
							label: "布局与裁切证据"
						}),
						/* @__PURE__ */ r(q, {
							value: R.raw,
							label: "节点属性与元数据"
						})
					] }) : _(t.result).source === "host-dom" ? /* @__PURE__ */ r(te, { value: t.result }) : /* @__PURE__ */ r(J, {
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
							y(ie.completeness, "未知"),
							v(ie.truncation).length ? " · 已截断" : ""
						]
					})]
				})]
			}) : /* @__PURE__ */ r(J, {
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
								value: A,
								onChange: (e) => j(e.currentTarget.value),
								children: [/* @__PURE__ */ r("option", {
									value: "",
									children: "选择快照"
								}), t.trees.map((e) => /* @__PURE__ */ r("option", { children: e.id }, e.id))]
							})] }),
							/* @__PURE__ */ i("label", { children: ["差异后 ", /* @__PURE__ */ i("select", {
								"aria-label": "差异后快照",
								className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50",
								value: M,
								onChange: (e) => N(e.currentTarget.value),
								children: [/* @__PURE__ */ r("option", {
									value: "",
									children: "选择快照"
								}), t.trees.map((e) => /* @__PURE__ */ r("option", { children: e.id }, e.id))]
							})] }),
							/* @__PURE__ */ r(W, {
								disabled: z || !A || !M || A === M,
								onClick: () => void a.diff(A, M),
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
					P && /* @__PURE__ */ r("p", {
						role: "alert",
						className: "text-[#8A4D00]",
						children: P
					}),
					/* @__PURE__ */ r(W, {
						disabled: z || !t.rootId,
						onClick: () => re(O, a.assertion),
						children: "执行断言"
					})
				]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/targets-view.tsx
function Z({ state: t, controller: a }) {
	let [o, s] = e.useState("browser"), [c, l] = e.useState(t.instanceId ?? ""), [u, d] = e.useState("");
	e.useEffect(() => {
		t.instanceId && l(t.instanceId);
	}, [t.instanceId]);
	let f = t.requested, p = t.targets.filter((e) => f ? f.candidates.some((t) => t.kind === e.kind && t.pluginId === e.pluginId) : e.kind === o && (o === "server" || e.instanceId === c)).filter((e) => e.pluginId.toLocaleLowerCase().includes(u.toLocaleLowerCase()));
	return /* @__PURE__ */ i("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ r("h2", {
					className: "mr-auto text-[15px] font-semibold",
					children: "要调试哪个插件？"
				}), /* @__PURE__ */ r(W, {
					disabled: !!t.busy,
					onClick: () => void a.refreshTargets(),
					children: "刷新插件列表"
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
				] }), /* @__PURE__ */ r(W, {
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
					"aria-label": "筛选插件",
					className: `${U} min-w-36 flex-1`,
					value: u,
					onChange: (e) => d(e.currentTarget.value),
					placeholder: "输入插件名称或标识"
				})]
			}),
			p.length ? /* @__PURE__ */ r("div", {
				className: "grid grid-cols-2 gap-3 max-[700px]:grid-cols-1",
				children: p.map((e) => /* @__PURE__ */ i("article", {
					className: `${t.target && E(t.target) === E(e) ? "border-[#6C4CF5] bg-[#EFEBFF]" : "border-[#E6EAF3] bg-white"} min-w-0 space-y-2 rounded-lg border p-4`,
					children: [
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap items-center gap-2",
							children: [/* @__PURE__ */ r("h3", {
								className: "min-w-0 flex-1 break-all text-sm font-semibold",
								children: e.pluginId
							}), /* @__PURE__ */ r(G, { children: e.kind === "browser" ? "浏览器" : "服务器" })]
						}),
						/* @__PURE__ */ i("p", {
							className: "break-all text-xs text-[#556176]",
							children: [
								e.instanceId === t.instanceId ? "当前实例" : e.instanceId || "服务器宿主",
								" · ",
								e.version || "版本未提供"
							]
						}),
						/* @__PURE__ */ i("details", {
							className: "text-xs text-[#556176]",
							children: [/* @__PURE__ */ r("summary", {
								className: "cursor-pointer",
								children: "完整目标身份"
							}), /* @__PURE__ */ i("p", {
								className: "mt-2 break-all",
								children: [
									"实例 ",
									/* @__PURE__ */ r("code", { children: e.instanceId ?? "服务器" }),
									" · 代次 ",
									/* @__PURE__ */ r("code", { children: e.generation ?? "未提供" })
								]
							})]
						}),
						/* @__PURE__ */ r(W, {
							disabled: !!t.busy,
							primary: !0,
							onClick: () => void a.select(e),
							children: "选择并查看调试过程"
						})
					]
				}, E(e)))
			}) : /* @__PURE__ */ r(J, {
				title: f ? "候选组件尚未出现在运行目录" : "尚无可调试目标",
				children: "请在原市场入口启用组件，或确认选定实例在线后刷新目录。安装存在不代表此浏览器已经启用。"
			}),
			t.target && /* @__PURE__ */ i("details", {
				className: "space-y-3 rounded-lg border border-[#E6EAF3] p-4",
				children: [
					/* @__PURE__ */ r("summary", {
						className: "cursor-pointer text-sm font-semibold",
						children: "当前目标能力与证据"
					}),
					/* @__PURE__ */ i("dl", { children: [
						/* @__PURE__ */ r(Y, {
							label: "选定插件",
							children: /* @__PURE__ */ r("code", { children: t.target.pluginId })
						}),
						/* @__PURE__ */ r(Y, {
							label: "完整实例",
							children: /* @__PURE__ */ r("code", { children: t.target.instanceId || "服务器目标" })
						}),
						/* @__PURE__ */ r(Y, {
							label: "代次",
							children: /* @__PURE__ */ r("code", { children: t.target.generation || "未提供" })
						})
					] }),
					/* @__PURE__ */ r("div", {
						className: "flex flex-wrap gap-2",
						children: Object.entries(_(_(t.inspection).capabilities)).filter(([, e]) => typeof e == "boolean").map(([e, t]) => /* @__PURE__ */ i(G, {
							warning: !t,
							children: [
								e,
								"：",
								t ? "支持" : "未提供"
							]
						}, e))
					}),
					v(_(t.inspection).cleanup_history).length > 0 && /* @__PURE__ */ i("div", {
						className: "rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
						children: ["旧代清理失败保留供诊断，不阻止独立新调用。", /* @__PURE__ */ r(q, {
							value: _(t.inspection).cleanup_history,
							label: "查看历史清理告警"
						})]
					}),
					/* @__PURE__ */ r(q, {
						value: t.inspection,
						label: "检查详情、登记资源与生命周期"
					})
				]
			})
		]
	});
}
function ie({ state: e, controller: t }) {
	let n = _(e.overview), a = _(n.page), o = v(_(e.inspection).slot_catalog), s = v(_(e.inspection).mount_catalog), c = v(n.nodes).length ? v(n.nodes) : [...o.map((e) => ({
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
				}), /* @__PURE__ */ r(W, {
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
					let o = _(n), s = _(o.catalog), c = y(s.id) || y(s.path) || y(s.contribution_id) || `条目 ${a + 1}`;
					return /* @__PURE__ */ i("article", {
						className: "rounded-lg border border-[#E6EAF3] p-3",
						children: [
							/* @__PURE__ */ i("div", {
								className: "flex flex-wrap items-center gap-2",
								children: [/* @__PURE__ */ r(G, { children: y(o.kind, "目录") }), /* @__PURE__ */ r("strong", {
									className: "break-all text-sm",
									children: y(s.label) || c
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
							o.kind === "route" && y(s.path) && /* @__PURE__ */ r(ae, {
								path: y(s.path),
								controller: t,
								disabled: e.stale || !!e.busy
							}),
							/* @__PURE__ */ r(q, {
								value: s,
								label: "目录证据"
							})
						]
					}, `${y(o.kind)}:${c}:${a}`);
				})
			}) : /* @__PURE__ */ r(J, {
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
			typeof a.nextOffset == "number" && /* @__PURE__ */ r(W, {
				disabled: e.stale || !!e.busy,
				onClick: () => void t.overview(Number(a.nextOffset)),
				children: "下一页目录"
			})
		]
	});
}
function ae({ path: t, controller: n, disabled: a }) {
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
		}), /* @__PURE__ */ r(W, {
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
function oe(e, t = 0) {
	let n = _(e);
	if (n.default !== void 0) return x(n.default);
	if (n.const !== void 0) return x(n.const);
	if (v(n.enum).length) return x(v(n.enum)[0]);
	if (t > 12) return null;
	if (n.type === "object" || n.properties) {
		let e = new Set(v(n.required));
		return Object.fromEntries(Object.entries(_(n.properties)).filter(([t, n]) => e.has(t) || _(n).default !== void 0).map(([e, n]) => [e, oe(x(n), t + 1)]));
	}
	return n.type === "array" ? [] : n.type === "boolean" ? !1 : n.type === "number" || n.type === "integer" ? typeof n.minimum == "number" ? n.minimum : 0 : n.type === "null" ? null : n.type === "string" ? "" : {};
}
function Q(e, t, n = "输入", r = 0) {
	if (t === !1) return [`${n}不接受任何值`];
	if (r > 32) return [`${n}模式嵌套过深，请使用简化参数`];
	let i = _(t), a = [];
	Array.isArray(i.enum) && !i.enum.some((t) => JSON.stringify(t) === JSON.stringify(e)) && a.push(`${n}必须来自枚举`), i.const !== void 0 && JSON.stringify(i.const) !== JSON.stringify(e) && a.push(`${n}必须符合固定值`);
	let o = Array.isArray(i.type) ? i.type : typeof i.type == "string" ? [i.type] : [];
	if (o.length && !o.some((t) => t === "null" ? e === null : t === "array" ? Array.isArray(e) : t === "object" ? j(e) : t === "integer" ? typeof e == "number" && Number.isInteger(e) : typeof e === t)) return [`${n}类型应为 ${o.join(" / ")}`];
	if (j(e)) {
		let t = _(i.properties);
		for (let t of v(i.required)) typeof t == "string" && !(t in e) && a.push(`${n}.${t}为必填项`);
		for (let [o, s] of Object.entries(e)) t[o] === void 0 ? i.additionalProperties === !1 && a.push(`${n}.${o}不允许额外字段`) : a.push(...Q(s, x(t[o]), `${n}.${o}`, r + 1));
	}
	return Array.isArray(e) && (typeof i.minItems == "number" && e.length < i.minItems && a.push(`${n}条目不足`), typeof i.maxItems == "number" && e.length > i.maxItems && a.push(`${n}条目过多`), i.items !== void 0 && e.forEach((e, t) => a.push(...Q(e, x(i.items), `${n}[${t}]`, r + 1)))), typeof e == "number" && (typeof i.minimum == "number" && e < i.minimum && a.push(`${n}小于 ${i.minimum}`), typeof i.maximum == "number" && e > i.maximum && a.push(`${n}大于 ${i.maximum}`)), typeof e == "string" && (typeof i.minLength == "number" && [...e].length < i.minLength && a.push(`${n}长度不足`), typeof i.maxLength == "number" && [...e].length > i.maxLength && a.push(`${n}长度超限`)), a;
}
function se(e) {
	let t = _(e);
	return !t.$ref && !t.anyOf && !t.oneOf && !t.allOf && (t.type === "object" || t.properties !== void 0);
}
var ce = (e) => y(_(e).title) || y(_(e).description);
//#endregion
//#region ../examples/browser-debugger/src/invoke-view.tsx
function le({ value: t, onChange: n, onError: i, label: a }) {
	let [o, s] = e.useState(JSON.stringify(t, null, 2));
	return /* @__PURE__ */ r("textarea", {
		"aria-label": a,
		className: `${U} min-h-28 w-full font-mono`,
		value: o,
		onChange: (e) => {
			s(e.currentTarget.value);
			try {
				n(S(e.currentTarget.value)), i("");
			} catch (e) {
				i(e instanceof Error ? e.message : "JSON 无效");
			}
		}
	});
}
function ue({ name: t, schema: n, value: a, required: o, onChange: s, onError: c }) {
	let l = _(n), u = v(l.enum), d = y(l.type), f = e.useId();
	return /* @__PURE__ */ i("div", {
		className: "space-y-1",
		children: [
			/* @__PURE__ */ i("label", {
				htmlFor: f,
				className: "flex items-center gap-2 text-[13px] font-medium",
				children: [
					ce(n) || t,
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
							s(e.currentTarget.checked ? oe(n) : void 0), c("");
						}
					})
				]
			}),
			a !== void 0 && (u.length ? /* @__PURE__ */ r("select", {
				id: f,
				className: "min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 w-full",
				value: JSON.stringify(a),
				onChange: (e) => s(S(e.currentTarget.value)),
				children: u.map((e, t) => /* @__PURE__ */ r("option", {
					value: JSON.stringify(e),
					children: typeof e == "string" ? e : JSON.stringify(e)
				}, t))
			}) : d === "boolean" ? /* @__PURE__ */ r(K, {
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
			}) : /* @__PURE__ */ r(le, {
				label: `${t} JSON`,
				value: a,
				onChange: s,
				onError: c
			}, t)),
			y(l.description) && /* @__PURE__ */ r("p", {
				className: "text-xs text-[#556176]",
				children: y(l.description)
			})
		]
	});
}
function de({ state: t, controller: a }) {
	let [o, s] = e.useState(""), c = t.entries.find((e) => e.key === o), [l, u] = e.useState({}), [d, f] = e.useState(!1), [p, m] = e.useState({}), [h, g] = e.useState(!1), [y, b] = e.useState(!1), [S, C] = e.useState(!1);
	e.useEffect(() => {
		s(""), g(!1), b(!1), C(!1);
	}, [t.sessionId]);
	let w = (e) => {
		u(e), g(!1), b(!1);
	}, T = c ? [...Object.values(p).filter(Boolean), ...Q(l, c.schema)] : [], E = _(_(c?.schema).properties), D = v(_(c?.schema).required);
	function O(e) {
		let n = t.entries.find((t) => t.key === e);
		s(e), u(n ? oe(n.schema) : {}), f(n ? !se(n.schema) : !1), m({}), g(!1), b(!1), C(!1);
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
					className: `${U} mt-1 w-full`,
					value: o,
					onChange: (e) => O(e.currentTarget.value),
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
						children: [/* @__PURE__ */ r(G, { children: c.kind }), /* @__PURE__ */ i("code", {
							className: "break-all text-xs",
							children: [c.id, c.version ? ` @ ${c.version}` : ""]
						})]
					}),
					c.reason && /* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#556176]",
						children: c.reason
					}),
					se(c.schema) && /* @__PURE__ */ r(K, {
						checked: d,
						onChange: (e) => {
							f(e), m({}), g(!1), b(!1);
						},
						children: "改用完整 JSON 输入"
					}),
					!d && se(c.schema) && j(l) ? /* @__PURE__ */ r("div", {
						className: "grid grid-cols-2 gap-3 max-[700px]:grid-cols-1",
						children: Object.entries(E).map(([e, t]) => /* @__PURE__ */ r(ue, {
							name: e,
							schema: x(t),
							value: l[e],
							required: D.includes(e),
							onChange: (t) => {
								let n = { ...l };
								t === void 0 ? delete n[e] : n[e] = t, w(n);
							},
							onError: (t) => m((n) => ({
								...n,
								[e]: t
							}))
						}, e))
					}) : /* @__PURE__ */ r(le, {
						label: "调用输入 JSON",
						value: l,
						onChange: w,
						onError: (e) => m({ input: e })
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
					t.target?.kind === "browser" && /* @__PURE__ */ r(K, {
						checked: S,
						onChange: (e) => {
							C(e), g(!1), b(!1);
						},
						children: "本次包含脱敏结果正文（默认仅元数据）"
					}),
					/* @__PURE__ */ r(K, {
						checked: h,
						onChange: g,
						children: "确认调用当前插件、代次和入口，参数已核对"
					}),
					/* @__PURE__ */ r(K, {
						checked: y,
						onChange: b,
						children: "允许未知副作用，可能影响设备或外部资源"
					}),
					/* @__PURE__ */ r(W, {
						primary: !0,
						disabled: !!t.busy || t.stale || !t.connected || !c.available || !h || !y || T.length > 0,
						onClick: () => {
							a.invoke(c, l, h, y, S), g(!1), b(!1);
						},
						children: "执行一次调用"
					}),
					/* @__PURE__ */ r(q, {
						value: c.schema,
						label: "输入模式"
					})
				]
			})] }) : /* @__PURE__ */ r(J, {
				title: "当前目标没有可试调用的公开入口",
				children: "请先选择目标并刷新检查。服务器操作和服务均沿原任务执行，服务另需精确版本。"
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/report.ts
function fe(e) {
	let t = e.activity, n = !!(t?.target && e.target && E(t.target) === E(e.target));
	return {
		page: n ? t : null,
		detail: n && t?.items.some((t) => t.commandId === e.activityDetail?.commandId) ? e.activityDetail : null
	};
}
function pe(e) {
	return e.events.filter((t) => t.target && e.target && E(t.target) === E(e.target));
}
function me(e, t = Date.now()) {
	let n = fe(e);
	return x({
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
		events: pe(e),
		activity: n.page,
		activity_detail: n.detail,
		activity_scope: {
			read_only: !0,
			retained_only: n.page?.retainedOnly ?? !0,
			gap: n.page?.gap ?? null,
			next_before: n.page?.nextBefore ?? null,
			cached_only: !0,
			description: "仅当前明确目标已缓存的公开调用摘要与选中原回执；未追加查询，不保证完整历史或跨重启保留"
		},
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
function he(e, t = Date.now()) {
	let n = e.target, r = fe(e), i = [
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
	for (let t of pe(e)) i.push(`| ${t.sequence} | ${$(t.label)} | ${$(t.target?.generation ?? "未知")} |`);
	i.push("", "## 调试调用摘要", "", "仅已缓存的公开摘要与选中回执；本次导出没有追加查询或重新执行。", "", `历史范围：${r.page?.retainedOnly ? "仅仍保留记录" : "未取得完整性证明"}；${r.page?.gap ? "存在淘汰缺口" : "未声明淘汰缺口，不代表完整历史"}。`, "", "| 调用 | 工具 | 原回执状态 |", "| --- | --- | --- |");
	for (let e of r.page?.items ?? []) i.push(`| ${$(e.commandId)} | ${$(e.tool)} | ${$(e.state)} |`);
	if (r.detail) {
		i.push("", `选中回执：${$(r.detail.commandId)}；原状态：${$(r.detail.state)}。`, "", "| 步骤 | 展示名称 | 工具 |", "| --- | --- | --- |");
		for (let e of r.detail.steps) i.push(`| ${$(e.id)} | ${$(e.label ?? e.tool)} | ${$(e.tool)} |`);
	}
	return i.push("", "## 证据范围", "", "仅公开服务和已缓存观测；可能存在未观测、分页或截断。不是完整安装、设备或生产验收报告。", "", "## 公开证据", "", "````json", JSON.stringify(me(e, t), null, 2).replace(/````/g, "\\u0060\\u0060\\u0060\\u0060"), "````", ""), i.join("\n");
}
function ge(e) {
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
function _e(e) {
	let t = _(e), n = _(_(t.report).evidence), r = [];
	for (let e of v(n.cached_trees)) {
		let t = _(e);
		for (let e of v(t.snapshots)) {
			let n = _(e), i = _(n.page);
			r.push({
				rootId: y(t.root_id),
				snapshotId: y(n.id),
				offset: b(i.offset),
				count: v(n.nodes).length
			});
		}
	}
	for (let e of v(t.ui_snapshot_pages)) {
		let t = _(e), n = _(t.tree), i = _(n.page);
		r.push({
			rootId: y(t.root_id),
			snapshotId: y(n.id),
			offset: b(i.offset),
			count: v(n.nodes).length
		});
	}
	for (let e of v(n.snapshot_manifest)) {
		let t = _(e), n = y(t.root_id);
		for (let e of v(t.snapshots)) {
			let t = _(e), i = y(t.id), a = b(t.total), o = 0;
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
function ve({ state: t, controller: n, context: a }) {
	let [o, s] = e.useState(!1), [c, l] = e.useState(!1), [u, d] = e.useState(""), f = e.useRef(null), p = e.useRef(null), m = e.useRef(new AbortController());
	e.useEffect(() => {
		let e = m.current;
		return () => {
			e.abort(), p.current?.dispose();
		};
	}, []), e.useEffect(() => s(!1), [t.target?.pluginId, t.target?.generation]);
	function h(e) {
		let n = f.current?.ownerDocument;
		if (n) try {
			p.current ??= ge(n);
			let r = e === "json" ? JSON.stringify(me(t), null, 2) : he(t);
			p.current.save(new Blob([r], { type: e === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" }), `deviceforge-debugger-${t.target?.pluginId ?? "snapshot"}-${Date.now()}.${e === "json" ? "json" : "md"}`), d("已请求浏览器下载当前公开证据，未自动采集新快照。");
		} catch (e) {
			d(e instanceof Error ? e.message : "下载失败");
		}
	}
	let g = _(_(_(t.report).artifact).metadata);
	async function b() {
		let e = y(g.id), t = f.current?.ownerDocument;
		if (a.artifacts && e && t) try {
			let n = AbortSignal.any([
				a.signal,
				m.current.signal,
				AbortSignal.timeout(15e3)
			]), r = await a.artifacts.download(e, n);
			n.throwIfAborted(), p.current ??= ge(t), p.current.save(r.data, y(g.filename, `debugger-report-${e}.json`)), d("已通过公开产物接口请求下载。");
		} catch (e) {
			m.current.signal.aborted || d(e instanceof Error ? e.message : "报告产物下载失败");
		}
	}
	let x = _(t.installation);
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
						children: [/* @__PURE__ */ r(G, {
							warning: t.stale,
							children: t.stale ? "缓存已过期" : "最近公开证据"
						}), /* @__PURE__ */ i("span", {
							className: "text-[13px]",
							children: [t.trees.length, " 个缓存快照"]
						})]
					}),
					/* @__PURE__ */ r(K, {
						checked: c,
						onChange: l,
						children: "请求宿主持久报告产物（以实际返回 artifact 为准）"
					}),
					/* @__PURE__ */ i("div", {
						className: "flex flex-wrap gap-2",
						children: [
							/* @__PURE__ */ r(W, {
								disabled: !t.sessionId || t.stale || !!t.busy,
								onClick: () => void n.report(c, "json"),
								children: "汇总公开报告"
							}),
							/* @__PURE__ */ r(W, {
								disabled: !t.target,
								onClick: () => h("json"),
								children: "下载 JSON"
							}),
							/* @__PURE__ */ r(W, {
								disabled: !t.target,
								onClick: () => h("markdown"),
								children: "下载 Markdown"
							}),
							y(g.id) && /* @__PURE__ */ r(W, {
								disabled: !a.artifacts,
								onClick: () => void b(),
								children: "下载宿主报告产物"
							})
						]
					}),
					y(g.id) && /* @__PURE__ */ i("dl", { children: [/* @__PURE__ */ r(Y, {
						label: "持久产物",
						children: /* @__PURE__ */ r("code", { children: y(g.id) })
					}), /* @__PURE__ */ r(Y, {
						label: "文件",
						children: y(g.filename, "宿主未提供文件名")
					})] }),
					_e(t.report) && /* @__PURE__ */ i("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [/* @__PURE__ */ r("p", {
							className: "text-[13px] text-[#8A4D00]",
							children: "报告仍有缓存快照页尚未加载；本地下载会如实保留当前完整性。"
						}), /* @__PURE__ */ r(W, {
							disabled: t.stale || !!t.busy,
							onClick: () => void n.reportNext(),
							children: "读取报告下一页"
						})]
					}),
					t.report !== null && /* @__PURE__ */ r(q, {
						value: t.report,
						label: "报告证据与快照清单"
					}),
					/* @__PURE__ */ r("p", {
						role: "status",
						className: "text-[13px] text-[#556176]",
						children: u
					}),
					/* @__PURE__ */ r(X, { value: t.logId })
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
					/* @__PURE__ */ r(W, {
						disabled: !!t.busy,
						onClick: () => void n.installation(),
						children: "查询安装与修订"
					}),
					t.installation !== null && /* @__PURE__ */ i("div", {
						className: "space-y-3",
						children: [
							v(x.installations).map((e, t) => {
								let n = _(e);
								return /* @__PURE__ */ i("article", {
									className: "rounded-md border border-[#E6EAF3] p-3",
									children: [
										/* @__PURE__ */ i("h3", {
											className: "break-all text-sm font-medium",
											children: [
												y(n.id),
												" · ",
												y(n.version)
											]
										}),
										/* @__PURE__ */ i("p", {
											className: "my-2 break-all text-xs text-[#556176]",
											children: [
												"安装修订 ",
												y(n.revision, "未知"),
												" · ",
												y(n.status)
											]
										}),
										v(n.components).map((e, t) => {
											let n = _(e);
											return /* @__PURE__ */ i("div", {
												className: "flex flex-wrap items-center gap-2 border-t border-[#E6EAF3] py-2 text-[13px]",
												children: [
													/* @__PURE__ */ r("code", {
														className: "break-all",
														children: y(n.id)
													}),
													/* @__PURE__ */ r(G, { children: y(n.kind) }),
													/* @__PURE__ */ r(G, {
														warning: n.build_state !== "current",
														children: n.build_state === "current" ? "运行修订已核对" : n.build_state === "refresh_required" ? "需更新运行实例" : "尚未观测构建"
													}),
													/* @__PURE__ */ i("span", {
														className: "break-all text-xs text-[#556176]",
														children: [
															"运行代次 ",
															y(n.running_generation, "未知"),
															" · 运行修订 ",
															y(n.running_revision, "未知")
														]
													})
												]
											}, t);
										})
									]
								}, t);
							}),
							v(x.standalone).map((e, t) => {
								let n = _(e);
								return /* @__PURE__ */ i("article", {
									className: "space-y-1 rounded-md border border-[#E6EAF3] p-3 text-[13px]",
									children: [/* @__PURE__ */ i("p", {
										className: "break-all font-medium",
										children: [
											y(n.id),
											" · ",
											y(n.kind),
											" · ",
											y(n.version)
										]
									}), /* @__PURE__ */ i("p", {
										className: "text-[#556176]",
										children: [
											"部署摘要：",
											y(n.digest, "未知"),
											" · ",
											y(n.digest_status, "宿主未观测")
										]
									})]
								}, t);
							}),
							!v(x.installations).length && !v(x.standalone).length && /* @__PURE__ */ r(J, { title: "未查询到已安装组件" }),
							/* @__PURE__ */ r("p", {
								className: "text-[13px] text-[#556176]",
								children: y(x.note)
							}),
							/* @__PURE__ */ r(q, {
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
					/* @__PURE__ */ r(K, {
						checked: o,
						onChange: s,
						children: "确认只重载上述插件和代次，随后核对新代次"
					}),
					/* @__PURE__ */ r(W, {
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
//#region ../examples/browser-debugger/src/activity-presentation.ts
var ye = {
	inspect: "检查插件",
	data_catalog: "查看数据目录",
	data_read: "读取数据",
	data_write: "修改数据",
	ui_tree: "读取界面",
	ui_query: "查找界面元素",
	ui_assert: "检查页面结果",
	ui_action: "操作界面",
	invoke: "调用公开能力",
	reload: "重载插件",
	report: "汇总报告",
	automation_run: "自动调试计划"
}, be = (e) => ye[e] ?? "调试调用";
function xe(e, t = !1) {
	let n = _(e), r = _(n.result), i = _(n.error), a = y(n.tool), o = y(n.status), s = "调用完成", c = "neutral", l = y(r.reason) || y(i.message);
	return t ? (s = "等待最终回执", l = "整段计划仍在执行，暂未取得此步骤的最终结果。") : o === "skipped" ? s = "未执行" : /indeterminate|unconfirmed|cancelled/.test(o) ? (s = "结果未确认", c = "warning") : o === "failed" ? (s = "执行失败", c = "error") : o === "succeeded" ? a === "ui_assert" ? r.status === "passed" ? (s = "页面检查通过", c = "success") : r.status === "failed" ? (s = "页面检查未通过", c = "error") : (s = "无法判定", c = "warning") : a === "data_read" ? s = "已读取" : a === "data_write" ? s = typeof r.revision == "string" && Object.hasOwn(r, "value") ? "已保存并回读" : "保存结果待核对" : (a === "ui_action" || a === "invoke") && (s = "已派发，业务结果未确认", l ||= "调用回执不代表业务操作完成，请通过明确检查核对实际状态。") : (s = "结果未知", c = "warning"), {
		id: y(n.id),
		label: y(n.label) || be(a),
		tool: a,
		status: s,
		tone: c,
		result: x(n.result ?? null),
		detail: l,
		logId: y(n.log_id) || null
	};
}
function Se(e) {
	let t = _(e), n = _(t.response), r = t.state === "queued" || t.state === "delivered";
	if (t.tool === "automation_run") {
		let e = v(n.steps);
		return (e.length ? e : v(t.steps)).map((e) => xe(x(e), r));
	}
	return y(t.commandId) ? [xe({
		id: y(t.commandId),
		tool: y(t.tool),
		status: t.state === "succeeded" ? "succeeded" : t.state === "failed" ? "failed" : "indeterminate",
		result: x(t.response ?? null)
	}, r)] : [];
}
function Ce(e, t) {
	let n = _(e), r = _(n.response);
	if (t) return {
		title: "连接已断开，显示最后一次结果",
		description: "历史内容仍可查看；当前页面状态尚未确认。",
		warning: !0
	};
	if (!y(n.commandId)) return {
		title: "等待第一条调试调用",
		description: "选定插件的公开调试记录会显示在这里，也可以先手动检查。",
		warning: !1
	};
	if (n.state === "queued" || n.state === "delivered") return {
		title: "计划执行中",
		description: "等待最终回执，步骤结果返回后更新。",
		warning: !1
	};
	if (/unconfirmed/.test(y(n.state)) || r.status === "indeterminate" || r.status === "cancelled") return {
		title: "请求已派发，结果尚未确认",
		description: "先查询原命令结果或读取实际状态，不自动重复执行。",
		warning: !0
	};
	if (n.state === "failed" || r.status === "failed") return {
		title: "调试结束，存在未通过的步骤",
		description: "查看步骤结果与日志，再决定下一步检查。",
		warning: !0
	};
	let i = Se(e).filter((e) => e.status === "页面检查通过").length;
	return {
		title: i ? `调试结束 · ${i}项页面检查通过` : "调试调用已结束",
		description: i ? "点击步骤查看对应结果；已通过的检查仅覆盖本次明确检查点。" : "调用回执已返回；业务是否完成仍需相应检查确认。",
		warning: !1
	};
}
//#endregion
//#region ../examples/browser-debugger/src/activity-view.tsx
function we({ state: t, controller: n, narrow: a, onData: o, onInspect: s, onDetails: c, onTargets: l }) {
	let [u, d] = e.useState(""), f = t.activityDetail ?? t.activity?.items[0] ?? null, p = Se(x(f)), m = p.find((e) => e.id === u) ?? p.at(-1), h = f?.state === "queued" || f?.state === "delivered";
	return e.useEffect(() => d(""), [f?.commandId]), t.target ? f ? /* @__PURE__ */ i("div", {
		className: `grid min-h-full gap-6 ${a ? "grid-cols-1" : "grid-cols-[minmax(0,1.66fr)_minmax(280px,1fr)]"}`,
		children: [/* @__PURE__ */ i("section", {
			className: "min-w-0 space-y-4",
			children: [
				/* @__PURE__ */ i("div", {
					className: "flex flex-wrap items-center gap-3",
					children: [
						/* @__PURE__ */ r("h2", {
							className: "mr-auto text-[15px] font-semibold",
							children: f.tool === "automation_run" ? `本次调试计划${p.length ? ` · ${p.length}步` : ""}` : be(f.tool)
						}),
						/* @__PURE__ */ i("span", {
							className: "text-xs text-[#556176]",
							children: ["外部工具调用", t.stale ? " · 已过期" : ""]
						}),
						/* @__PURE__ */ r(W, {
							disabled: !!t.busy,
							onClick: () => void n.refreshActivity(),
							children: "刷新"
						})
					]
				}),
				/* @__PURE__ */ r("div", {
					className: "overflow-hidden rounded-xl border border-[#E6EAF3]",
					children: p.length ? p.map((e, n) => /* @__PURE__ */ i("button", {
						type: "button",
						"aria-pressed": m?.id === e.id,
						onClick: () => d(e.id),
						className: `${m?.id === e.id ? "bg-[#EFEBFF]" : n % 2 ? "bg-[#FBFCFE]" : "bg-white"} flex min-h-20 w-full items-center gap-4 px-5 py-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`,
						children: [
							/* @__PURE__ */ r("span", {
								"aria-hidden": "true",
								className: e.tone === "success" ? "text-[#17664F]" : e.tone === "error" || e.tone === "warning" ? "text-[#8A4D00]" : "text-[#556176]",
								children: h ? "○" : e.tone === "error" ? "!" : e.tone === "warning" ? "?" : e.status === "未执行" ? "—" : "✓"
							}),
							/* @__PURE__ */ r("span", {
								className: "min-w-0 break-words font-medium",
								children: e.label
							}),
							/* @__PURE__ */ r("span", {
								"aria-hidden": "true",
								className: "text-[#556176]",
								children: "·"
							}),
							/* @__PURE__ */ i("span", {
								className: `${e.tone === "success" ? "text-[#17664F]" : e.tone === "warning" || e.tone === "error" ? "text-[#8A4D00]" : "text-[#23272E]"} min-w-0 break-words`,
								children: [t.stale ? "当时" : "", e.status]
							})
						]
					}, e.id || n)) : /* @__PURE__ */ r("p", {
						className: "p-5 text-sm text-[#556176]",
						children: h ? "整段计划执行中，等待最终回执；尚未取得可展示的步骤。" : "回执未提供步骤正文，可在技术详情查看留存信息。"
					})
				}),
				/* @__PURE__ */ r("p", {
					className: "text-[13px] leading-relaxed text-[#556176]",
					children: t.stale ? "这些是断线前的历史证据，不代表当前页面仍保持相同状态。" : h ? "等待最终回执；暂不显示逐步成功或失败。" : "点击步骤可查看结果。只有明确通过的检查会标记为通过。"
				}),
				(t.activity?.gap || t.activity?.retainedOnly) && /* @__PURE__ */ i("p", {
					className: "text-xs text-[#556176]",
					children: [t.activity?.gap ? "记录存在保留缺口。" : "", "此处仅展示仍留存的命令，不是完整历史。"]
				}),
				(t.activity?.items.length ?? 0) > 1 && /* @__PURE__ */ i("details", {
					className: "rounded-lg border border-[#E6EAF3] p-3 text-[13px]",
					children: [/* @__PURE__ */ i("summary", {
						className: "cursor-pointer text-[#556176]",
						children: [
							"其他调试调用（",
							t.activity?.items.length,
							"）"
						]
					}), /* @__PURE__ */ r("div", {
						className: "mt-2 space-y-2",
						children: t.activity?.items.filter((e) => e.commandId !== f.commandId).map((e) => /* @__PURE__ */ i(W, {
							onClick: () => void n.selectActivity(e.commandId),
							children: [
								be(e.tool),
								" · ",
								e.state === "succeeded" ? "已返回" : e.state === "failed" ? "失败" : "等待核对"
							]
						}, e.commandId))
					})]
				}),
				t.activity?.nextBefore != null && /* @__PURE__ */ r(W, {
					disabled: !!t.busy,
					onClick: () => void n.refreshActivity(t.activity?.nextBefore ?? void 0),
					children: "查看更早记录"
				})
			]
		}), /* @__PURE__ */ i("aside", {
			"aria-label": "选中步骤的执行结果",
			className: "min-w-0 space-y-5 rounded-xl bg-[#F7F8FC] p-6",
			children: [
				/* @__PURE__ */ i("h3", {
					className: "text-sm font-semibold",
					children: ["执行结果", t.stale ? " · 最后观测" : ""]
				}),
				/* @__PURE__ */ r("h4", {
					className: `text-lg font-semibold ${m?.tone === "success" ? "text-[#17664F]" : m?.tone === "warning" || m?.tone === "error" || t.stale ? "text-[#8A4D00]" : "text-[#23272E]"}`,
					children: t.stale ? "最后观测内容" : h ? "正在等待结果" : m?.status ?? "回执已返回"
				}),
				/* @__PURE__ */ r("p", {
					className: "break-words text-sm leading-relaxed text-[#556176]",
					children: t.stale ? "当前状态尚未确认。重新连接只恢复观察，不会自动重放先前动作。" : m?.detail || (h ? "最终结果返回后，这里会显示对应步骤的公开证据。" : "已收到此步骤回执，完整证据与日志在技术详情中。")
				}),
				!h && /* @__PURE__ */ i("div", {
					className: "flex flex-col gap-3",
					children: [
						(/unconfirmed/.test(f.state) || _(f.response).status === "indeterminate" || _(f.response).status === "cancelled") && /* @__PURE__ */ r(W, {
							primary: !0,
							disabled: !!t.busy,
							onClick: () => void n.selectActivity(f.commandId),
							children: "查询原命令结果"
						}),
						/* @__PURE__ */ r(W, {
							disabled: t.stale || !t.connected,
							onClick: o,
							children: "查看当前数据"
						}),
						/* @__PURE__ */ r(W, {
							onClick: c,
							children: "查看技术详情与日志"
						})
					]
				}),
				m?.logId && /* @__PURE__ */ r(X, { value: m.logId }),
				/* @__PURE__ */ i("details", {
					className: "text-[13px] text-[#556176]",
					children: [/* @__PURE__ */ r("summary", {
						className: "cursor-pointer",
						children: "此步骤的公开证据"
					}), /* @__PURE__ */ r("div", {
						className: "mt-3",
						children: /* @__PURE__ */ r(q, {
							value: m?.result ?? _(f.response),
							label: "展开原始结果"
						})
					})]
				})
			]
		})]
	}) : /* @__PURE__ */ i("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ i("div", {
				className: "flex flex-wrap items-center gap-3",
				children: [/* @__PURE__ */ r("h2", {
					className: "mr-auto text-[15px] font-semibold",
					children: "当前插件的调试过程"
				}), /* @__PURE__ */ r(W, {
					disabled: !!t.busy,
					onClick: () => void n.refreshActivity(),
					children: "刷新记录"
				})]
			}),
			/* @__PURE__ */ i("div", {
				className: "flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-[#E6EAF3] bg-[#F7F8FC] p-6 text-center",
				children: [
					/* @__PURE__ */ r("h3", {
						className: "text-lg font-semibold",
						children: "等待第一条调试调用"
					}),
					/* @__PURE__ */ r("p", {
						className: "max-w-xl text-sm leading-relaxed text-[#556176]",
						children: t.activity?.unavailable || "Agent 调用这个插件的公开调试工具后，可以在这里查看调用和结果。也可以先手动检查界面或数据。"
					}),
					/* @__PURE__ */ i("div", {
						className: "flex flex-wrap justify-center gap-3",
						children: [/* @__PURE__ */ r(W, {
							primary: !0,
							disabled: !t.connected || t.stale,
							onClick: s,
							children: "在页面上选择"
						}), /* @__PURE__ */ r(W, {
							onClick: o,
							children: "查看数据"
						})]
					})
				]
			}),
			/* @__PURE__ */ r("p", {
				className: "text-xs text-[#556176]",
				children: "这里只保留当前宿主仍留存的调用；没有记录不代表从未调用，也不代表 Agent 离线。"
			})
		]
	}) : /* @__PURE__ */ i(J, {
		title: "先选择要调试的插件",
		children: [/* @__PURE__ */ r("p", { children: "选择插件 → 让 Agent 调用调试工具 → 在这里查看过程与结果。" }), /* @__PURE__ */ r("div", {
			className: "mt-4",
			children: /* @__PURE__ */ r(W, {
				primary: !0,
				onClick: l,
				children: "选择插件"
			})
		})]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/timeline-view.tsx
function Te({ state: t, controller: a }) {
	let [o, s] = e.useState(""), [c, l] = e.useState(!0), [u, d] = e.useState(""), [f, p] = e.useState(!1), [m, h] = e.useState(null), [g, b] = e.useState(""), [x, S] = e.useState(!0), C = e.useRef(null);
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
		f && C.current?.scrollIntoView({ block: "nearest" });
	}, [t.events.length, f]);
	let w = t.events.filter((e) => (!o || e.level === o) && (c || !t.target || e.target && E(e.target) === E(t.target)) && (!u || `${e.label} ${e.logId ?? ""} ${e.target?.pluginId ?? ""}`.toLocaleLowerCase().includes(u.toLocaleLowerCase()))), T = _(t.logs);
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
						className: U,
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
					/* @__PURE__ */ i(K, {
						checked: c,
						onChange: l,
						children: ["包含旧代：", c ? "开" : "关"]
					}),
					/* @__PURE__ */ r("input", {
						"aria-label": "搜索事件",
						className: `${U} min-w-32 flex-1`,
						placeholder: "搜索事件、插件、日志 ID",
						value: u,
						onChange: (e) => d(e.currentTarget.value)
					}),
					/* @__PURE__ */ r("span", {
						className: "text-[13px] text-[#556176]",
						children: f ? "自动跟随中" : "已暂停跟随"
					}),
					/* @__PURE__ */ r(W, {
						onClick: () => p(!f),
						children: f ? "暂停跟随" : "继续跟随"
					}),
					/* @__PURE__ */ r(W, {
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
					children: [w.length ? /* @__PURE__ */ i("table", {
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
						}), /* @__PURE__ */ r("tbody", { children: w.map((e) => /* @__PURE__ */ i("tr", {
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
										onClick: () => h(e),
										children: e.label
									})
								}),
								/* @__PURE__ */ r("td", {
									className: "p-2 font-mono text-xs",
									children: e.target?.generation ?? "未知"
								})
							]
						}, e.key)) })]
					}) : /* @__PURE__ */ r(J, {
						title: "暂无匹配的已缓存事件",
						children: "可手动读取下一页，或继续跟随。暂停仅影响自动读取，不暂停业务。"
					}), /* @__PURE__ */ r("div", { ref: C })]
				}), /* @__PURE__ */ r("section", {
					className: "min-w-0 space-y-3 rounded-lg border border-[#E6EAF3] p-3",
					"aria-label": "事件详情",
					children: m ? /* @__PURE__ */ i(n, { children: [
						/* @__PURE__ */ r("h3", {
							className: "break-all text-sm font-medium",
							children: m.label
						}),
						/* @__PURE__ */ r(G, {
							warning: m.level === "error",
							children: m.level
						}),
						/* @__PURE__ */ i("p", {
							className: "break-all text-xs text-[#556176]",
							children: [
								m.target?.pluginId ?? "目标未知",
								" · ",
								m.target?.generation ?? "代次未知"
							]
						}),
						/* @__PURE__ */ r(X, { value: m.logId }),
						/* @__PURE__ */ r(q, {
							value: m.raw,
							label: "事件详情"
						})
					] }) : /* @__PURE__ */ r(J, { title: "选择事件查看详情" })
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
							e.preventDefault(), a.logs(g, x);
						},
						children: [
							/* @__PURE__ */ i("select", {
								"aria-label": "日志查询方式",
								className: U,
								value: x ? "id" : "text",
								onChange: (e) => S(e.currentTarget.value === "id"),
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
								className: `${U} min-w-40 flex-1`,
								value: g,
								onChange: (e) => b(e.currentTarget.value),
								placeholder: x ? "填写完整日志 ID 或任务 ID" : "1 至 128 字节搜索词"
							}),
							/* @__PURE__ */ r(W, {
								type: "submit",
								disabled: !!t.busy || !g.trim(),
								children: "查询日志"
							}),
							t.logId && /* @__PURE__ */ r(W, {
								onClick: () => {
									S(!0), b(t.logId ?? "");
								},
								children: "带入最近日志 ID"
							})
						]
					}),
					T.limited === !0 && /* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#8A4D00]",
						children: "结果已截断，仅展示公开搜索返回的有界条目。"
					}),
					t.logs !== null && /* @__PURE__ */ r("div", {
						className: "max-h-72 overflow-auto",
						children: v(T.entries).length ? v(T.entries).map((e, t) => {
							let n = _(e);
							return /* @__PURE__ */ i("article", {
								className: "space-y-1 border-b border-[#E6EAF3] py-2 text-[13px]",
								children: [
									/* @__PURE__ */ i("div", {
										className: "flex flex-wrap gap-2",
										children: [
											/* @__PURE__ */ r(G, {
												warning: y(n.level).toLowerCase() === "error",
												children: y(n.level)
											}),
											/* @__PURE__ */ r("time", {
												className: "text-xs text-[#556176]",
												children: y(n.timestamp)
											}),
											/* @__PURE__ */ r("code", {
												className: "text-xs",
												children: y(n.code)
											})
										]
									}),
									/* @__PURE__ */ r("p", {
										className: "break-all",
										children: y(n.message)
									}),
									/* @__PURE__ */ r(X, { value: y(n.log_id) || null })
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
//#region ../examples/browser-debugger/src/details-view.tsx
function Ee({ state: e, controller: t, context: n, onInvoke: a, onResize: o }) {
	return /* @__PURE__ */ i("div", {
		className: "space-y-4",
		children: [
			/* @__PURE__ */ r("p", {
				className: "text-sm text-[#556176]",
				children: "按需展开完整身份、能力、日志和证据。查看历史不会重新执行原操作。"
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "目标身份与公开登记"
				}), /* @__PURE__ */ i("div", {
					className: "mt-3 space-y-3",
					children: [
						/* @__PURE__ */ i("dl", { children: [
							/* @__PURE__ */ r(Y, {
								label: "插件",
								children: /* @__PURE__ */ r("code", { children: e.target?.pluginId ?? "未选择" })
							}),
							/* @__PURE__ */ r(Y, {
								label: "浏览器实例",
								children: /* @__PURE__ */ r("code", { children: e.target?.instanceId ?? "服务器目标" })
							}),
							/* @__PURE__ */ i(Y, {
								label: "代次",
								children: [/* @__PURE__ */ r("code", { children: e.target?.generation ?? "未提供" }), e.stale ? "（已过期）" : ""]
							}),
							/* @__PURE__ */ i(Y, {
								label: "观察会话",
								children: [
									/* @__PURE__ */ r("code", { children: e.sessionId ?? "未打开" }),
									" · ",
									e.sessionState
								]
							})
						] }),
						/* @__PURE__ */ r(W, {
							disabled: !e.sessionId || e.stale || !!e.busy,
							onClick: () => void t.refreshInspection(),
							children: "刷新公开登记"
						}),
						/* @__PURE__ */ r(X, { value: e.logId }),
						/* @__PURE__ */ r(q, {
							value: e.inspection,
							label: "登记资源、能力与历史清理告警"
						}),
						!e.sessionCleanupSupported && /* @__PURE__ */ r("p", {
							className: "rounded-lg bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
							children: "此宿主缺少会话生命周期登记，请先关闭观察会话再停用调试器。"
						})
					]
				})]
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "公开能力、槽位与路由"
				}), /* @__PURE__ */ i("div", {
					className: "mt-4 space-y-4",
					children: [/* @__PURE__ */ r(W, {
						disabled: !e.sessionId || e.stale,
						onClick: a,
						children: "调用公开能力"
					}), /* @__PURE__ */ r(ie, {
						state: e,
						controller: t
					})]
				})]
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "日志与事件"
				}), /* @__PURE__ */ r("div", {
					className: "mt-4",
					children: /* @__PURE__ */ r(Te, {
						state: e,
						controller: t
					})
				})]
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "报告、安装修订与插件操作"
				}), /* @__PURE__ */ r("div", {
					className: "mt-4",
					children: /* @__PURE__ */ r(ve, {
						state: e,
						controller: t,
						context: n
					})
				})]
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "本次调用完整证据"
				}), /* @__PURE__ */ i("div", {
					className: "mt-3",
					children: [/* @__PURE__ */ r(q, {
						value: e.activityDetail,
						label: "调用与最终回执"
					}), /* @__PURE__ */ r(q, {
						value: e.result,
						label: "最近手动操作结果"
					})]
				})]
			}),
			/* @__PURE__ */ i("details", {
				className: "rounded-xl border border-[#E6EAF3] p-4",
				children: [/* @__PURE__ */ r("summary", {
					className: "cursor-pointer text-sm font-semibold",
					children: "面板设置"
				}), /* @__PURE__ */ i("div", {
					className: "mt-3 space-y-2",
					children: [/* @__PURE__ */ r("p", {
						className: "text-[13px] text-[#556176]",
						children: "拖动标题栏移动浮窗，拖动右下角改变尺寸。Alt + 方向键移动悬浮球。"
					}), /* @__PURE__ */ r(W, {
						onClick: o,
						children: "使用键盘调整尺寸"
					})]
				})]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/data-view.tsx
function De({ state: t, controller: n, narrow: a }) {
	let [o, s] = e.useState(""), [c, l] = e.useState(""), [u, d] = e.useState(null), [f, p] = e.useState(!1), [m, h] = e.useState({}), [g, y] = e.useState("null"), [b, C] = e.useState(""), w = e.useRef(!0);
	e.useEffect(() => (w.current = !0, () => {
		w.current = !1;
	}), []);
	let T = t.dataSnapshot?.sourceId === o ? t.dataSnapshot : null, E = t.dataSources.find((e) => e.id === o), D = f && T && T.revision !== c, O = t.stale || !t.connected || !!t.busy;
	e.useEffect(() => {
		s(""), C(""), l(""), p(!1), d(null), h({});
	}, [t.sessionId]), e.useEffect(() => {
		T && !f && (d(T.value), y(JSON.stringify(T.value, null, 2)), l(T.revision), h({}));
	}, [T, f]);
	function k(e) {
		f ? C(e) : A(e);
	}
	function A(e) {
		C(""), s(e), p(!1), d(null), l(""), h({}), n.readDataSource(e);
	}
	function M(e) {
		d(e), y(JSON.stringify(e, null, 2)), p(!0);
	}
	async function N() {
		if (!E || !c || !T || D) return;
		let e = t.sessionId;
		await n.writeDataSource(E.id, c, u, !0);
		let r = n.snapshot();
		w.current && r.sessionId === e && !r.error && !r.dataConflict && r.dataSnapshot?.sourceId === o && r.dataSnapshot.revision !== c && (p(!1), l(r.dataSnapshot.revision), d(r.dataSnapshot.value), y(JSON.stringify(r.dataSnapshot.value, null, 2)));
	}
	if (t.target?.kind === "server") return /* @__PURE__ */ r(J, {
		title: "服务器数据通过公开能力读取",
		children: "服务器插件仍沿原公开服务与任务入口使用。此面板只显示浏览器插件主动登记的数据源。"
	});
	let P = E && T ? [...Object.values(m).filter(Boolean), ...E.schemaComplete ? Q(u, E.schema) : []] : [], F = E?.applyPolicy === "next_invocation" ? "下次调用生效" : E?.applyPolicy === "reload" ? "重载后生效" : E?.applyPolicy === "immediate" ? "按插件声明立即生效" : "生效方式未提供，请核对插件";
	return /* @__PURE__ */ i("div", {
		className: `grid gap-6 ${a ? "grid-cols-1" : "grid-cols-[224px_minmax(0,1fr)]"}`,
		children: [/* @__PURE__ */ i("aside", {
			className: "space-y-4",
			children: [
				/* @__PURE__ */ i("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [/* @__PURE__ */ r("h2", {
						className: "mr-auto text-sm font-semibold",
						children: "插件公开的数据"
					}), /* @__PURE__ */ r(W, {
						disabled: O,
						onClick: () => void n.refreshDataSources(),
						children: "刷新"
					})]
				}),
				t.dataSources.length ? /* @__PURE__ */ r("div", {
					className: "space-y-2",
					children: t.dataSources.map((e) => /* @__PURE__ */ i("button", {
						type: "button",
						disabled: O,
						"aria-pressed": e.id === o,
						onClick: () => k(e.id),
						className: `${e.id === o ? "bg-[#EFEBFF] text-[#6C4CF5]" : "bg-white text-[#23272E]"} min-h-24 w-full rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:opacity-50`,
						children: [/* @__PURE__ */ r("span", {
							className: "block text-sm font-medium",
							children: e.label
						}), /* @__PURE__ */ i("span", {
							className: "mt-2 block text-xs text-[#556176]",
							children: [
								e.writable ? "可修改" : "只读",
								" · ",
								e.persistence === "persistent" ? "持久保存" : e.persistence === "memory" ? "内存数据" : "持久性未提供"
							]
						})]
					}, e.id))
				}) : /* @__PURE__ */ r("p", {
					className: "rounded-xl bg-[#F7F8FC] p-4 text-[13px] leading-relaxed text-[#556176]",
					children: "插件尚未公开数据源。空目录不代表插件没有内部状态。"
				}),
				/* @__PURE__ */ r("p", {
					className: "text-[13px] leading-relaxed text-[#556176]",
					children: "只列出插件主动公开的数据。修改不会读取插件私有状态。"
				}),
				b && /* @__PURE__ */ i("div", {
					className: "space-y-3 rounded-lg bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
					children: [
						/* @__PURE__ */ r("p", { children: "当前编辑尚未保存，切换会放弃这些编辑。" }),
						/* @__PURE__ */ r(W, {
							onClick: () => A(b),
							children: "放弃编辑并切换"
						}),
						/* @__PURE__ */ r(W, {
							onClick: () => C(""),
							children: "继续编辑"
						})
					]
				})
			]
		}), !E || !T ? /* @__PURE__ */ i(J, {
			title: E ? "正在读取公开数据" : "选择一个公开数据源",
			children: ["在左侧选择数据后，可以查看业务字段、只读状态和生效方式。", t.dataNotice && /* @__PURE__ */ r("p", {
				className: "mt-3",
				children: t.dataNotice
			})]
		}) : /* @__PURE__ */ i("section", {
			className: "min-w-0 space-y-5",
			children: [
				/* @__PURE__ */ i("div", {
					className: "space-y-2",
					children: [
						/* @__PURE__ */ r("h3", {
							className: "text-lg font-semibold",
							children: E.label
						}),
						/* @__PURE__ */ i("p", {
							className: "text-sm text-[#8A4D00]",
							children: [f ? "有未保存修改 · " : "", F]
						}),
						!E.writable && /* @__PURE__ */ r(G, { children: "只读数据源" })
					]
				}),
				t.dataNotice && /* @__PURE__ */ r("p", {
					role: "status",
					className: "rounded-xl bg-[#FDF6ED] p-4 text-sm leading-relaxed text-[#8A4D00]",
					children: t.dataNotice
				}),
				t.dataConflict && /* @__PURE__ */ i("div", {
					role: "alert",
					className: "space-y-2 rounded-xl bg-[#FDF6ED] p-5 text-sm leading-relaxed text-[#8A4D00]",
					children: [/* @__PURE__ */ r("h4", {
						className: "font-semibold",
						children: "数据已发生变化，你的编辑已保留"
					}), /* @__PURE__ */ r("p", { children: "其他调用已经更新了这份数据。本次保存未覆盖新值，请读取最新值后比较。" })]
				}),
				/* @__PURE__ */ r("fieldset", {
					disabled: O || !E.writable,
					className: "min-w-0 space-y-5 disabled:opacity-60",
					children: se(E.schema) && j(u) ? Object.entries(_(_(E.schema).properties)).map(([e, t]) => /* @__PURE__ */ r("fieldset", {
						disabled: _(t).readOnly === !0,
						children: /* @__PURE__ */ r(ue, {
							name: e,
							schema: x(t),
							value: u[e],
							required: v(_(E.schema).required).includes(e),
							onChange: (t) => {
								if (!j(u)) return;
								let n = { ...u };
								t === void 0 ? delete n[e] : n[e] = t, M(n);
							},
							onError: (t) => h((n) => ({
								...n,
								[e]: t
							}))
						})
					}, e)) : /* @__PURE__ */ r(le, {
						value: u,
						label: "公开数据JSON",
						onChange: M,
						onError: (e) => h({ json: e })
					}, `${o}:${c}`)
				}),
				D && /* @__PURE__ */ i("div", {
					className: "space-y-4 rounded-xl border border-[#E6EAF3] bg-[#F7F8FC] p-4",
					children: [
						/* @__PURE__ */ r("h4", {
							className: "text-sm font-semibold",
							children: "最新值已读取，你的编辑仍保留"
						}),
						/* @__PURE__ */ r(q, {
							value: T.value,
							label: "查看刚读取的最新值"
						}),
						/* @__PURE__ */ r("p", {
							className: "text-[13px] text-[#556176]",
							children: "比较后明确选择要保留的内容；这里不会自动保存。"
						}),
						/* @__PURE__ */ i("div", {
							className: "flex flex-wrap gap-3",
							children: [/* @__PURE__ */ r(W, {
								onClick: () => {
									l(T.revision);
								},
								children: "保留我的编辑，使用最新修订"
							}), /* @__PURE__ */ r(W, {
								onClick: () => {
									p(!1), d(T.value), y(JSON.stringify(T.value, null, 2)), l(T.revision);
								},
								children: "采用最新值，放弃我的编辑"
							})]
						})
					]
				}),
				/* @__PURE__ */ i("details", {
					className: "text-[13px] text-[#556176]",
					children: [/* @__PURE__ */ r("summary", {
						className: "cursor-pointer",
						children: "高级 JSON 与修订信息"
					}), /* @__PURE__ */ i("div", {
						className: "mt-3 space-y-3",
						children: [
							/* @__PURE__ */ i("p", {
								className: "break-all",
								children: ["当前编辑基于修订 ", /* @__PURE__ */ r("code", { children: c })]
							}),
							!E.schemaComplete && /* @__PURE__ */ r("p", {
								className: "text-[#8A4D00]",
								children: "模式含被省略的敏感字段，不能用脱敏占位值恢复秘密。"
							}),
							/* @__PURE__ */ r("textarea", {
								"aria-label": "高级数据JSON",
								className: `${U} min-h-40 w-full font-mono`,
								disabled: O || !E.writable,
								value: g,
								onChange: (e) => {
									y(e.currentTarget.value), p(!0);
									try {
										d(S(e.currentTarget.value)), h({});
									} catch (e) {
										h({ json: e instanceof Error ? e.message : "JSON无效" });
									}
								}
							}),
							/* @__PURE__ */ r(q, {
								value: E.schema,
								label: "公开数据模式"
							})
						]
					})]
				}),
				P.length > 0 && /* @__PURE__ */ r("ul", {
					role: "alert",
					className: "list-inside list-disc text-[13px] text-[#8A4D00]",
					children: P.map((e, t) => /* @__PURE__ */ r("li", { children: e }, t))
				}),
				/* @__PURE__ */ i("div", {
					className: "flex flex-wrap gap-3",
					children: [E.writable && !t.dataConflict && !t.error?.unconfirmed && /* @__PURE__ */ r(W, {
						primary: !0,
						disabled: O || !f || !c || !!D || P.length > 0,
						onClick: () => void N(),
						children: "保存这次修改"
					}), /* @__PURE__ */ r(W, {
						primary: t.dataConflict || t.error?.unconfirmed === !0,
						disabled: O,
						onClick: () => void n.readDataSource(o),
						children: t.error?.unconfirmed ? "读取实际状态并比较" : f || t.dataConflict ? "读取最新值并比较" : "重新读取数据"
					})]
				})
			]
		})]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/view.tsx
var Oe = {
	process: "调试过程",
	targets: "选择调试插件",
	tree: "检查界面",
	data: "查看数据",
	invoke: "调用公开能力",
	details: "技术详情",
	report: "保存调试报告"
};
function ke({ controller: t, context: a }) {
	let d = e.useSyncExternalStore(t.subscribe, t.snapshot, t.snapshot), [f, g] = e.useState("process"), [_, v] = e.useState({
		x: 112,
		y: 48,
		width: 1200,
		height: 704
	}), [y, b] = e.useState({
		x: 16,
		y: 16
	}), [S, C] = e.useState(null), w = e.useRef(null), T = e.useRef(null), E = e.useRef(null), D = e.useRef(!1), O = e.useRef(null), k = () => {
		let e = T.current?.ownerDocument.defaultView;
		return {
			width: e?.innerWidth ?? 1424,
			height: e?.innerHeight ?? 805
		};
	};
	e.useEffect(() => {
		let e = T.current?.ownerDocument.defaultView;
		if (!e) return;
		v(s(k())), b(u(e.innerWidth - 72, e.innerHeight - 64, k(), !0));
		let t = () => {
			v((e) => o(e, k())), b((e) => u(e.x, e.y, k(), !0));
		};
		return e.addEventListener("resize", t), () => e.removeEventListener("resize", t);
	}, []), e.useEffect(() => {
		let e = T.current?.ownerDocument;
		if (e && !d.open) return m(e, () => {
			O.current?.mode !== "ball" && b((t) => {
				let n = u(t.x, t.y, k(), !1, p(e, t.x));
				return n.x === t.x && n.y === t.y ? t : n;
			});
		});
	}, [d.open]), e.useEffect(() => {
		if (!d.open) return;
		let e = requestAnimationFrame(() => w.current?.focus());
		return () => cancelAnimationFrame(e);
	}, [d.open]), e.useEffect(() => {
		d.requested && g("targets");
	}, [d.requested]), e.useEffect(() => {
		d.sessionId && g("process");
	}, [d.sessionId]), e.useEffect(() => {
		if (!d.open) return;
		let e = !1, n = !1, r = setInterval(() => {
			e || t.snapshot().busy || (e = !0, (async () => {
				try {
					await t.checkConnection(), !n && d.sessionId && f === "process" && await t.refreshActivity();
				} finally {
					e = !1;
				}
			})());
		}, 5e3);
		return () => {
			n = !0, clearInterval(r);
		};
	}, [
		d.open,
		d.sessionId,
		f,
		t
	]), e.useEffect(() => {
		if (!d.busy?.startsWith("拾取")) return;
		let e = T.current?.ownerDocument, n = (e) => {
			e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), t.cancel(), w.current?.focus());
		};
		return e?.addEventListener("keydown", n, !0), () => e?.removeEventListener("keydown", n, !0);
	}, [d.busy, t]);
	function A() {
		t.collapse(), C(null), requestAnimationFrame(() => T.current?.focus());
	}
	function j(e, t) {
		t.button === 0 && (e === "move" && t.target instanceof Element && t.target.closest("button,input,select,textarea,a") || (t.currentTarget.setPointerCapture(t.pointerId), O.current = {
			mode: e,
			pointerId: t.pointerId,
			x: t.clientX,
			y: t.clientY,
			rect: _,
			ball: y,
			moved: !1
		}));
	}
	function M(e) {
		let t = O.current;
		if (!t || t.pointerId !== e.pointerId) return;
		let n = e.clientX - t.x, r = e.clientY - t.y;
		Math.abs(n) + Math.abs(r) > 5 && (t.moved = !0), t.moved && (t.mode === "ball" ? b(u(t.ball.x + n, t.ball.y + r, k(), !1)) : t.mode === "move" ? v(o({
			...t.rect,
			x: t.rect.x + n,
			y: t.rect.y + r
		}, k())) : v(o({
			...t.rect,
			width: t.rect.width + n,
			height: t.rect.height + r
		}, k())));
	}
	function N(e) {
		let t = O.current;
		t && t.pointerId === e.pointerId && (e.currentTarget.hasPointerCapture(e.pointerId) && e.currentTarget.releasePointerCapture(e.pointerId), O.current = null, t.mode === "ball" && t.moved ? (b((e) => {
			let t = u(e.x, e.y, k(), !0), n = T.current?.ownerDocument;
			return n ? u(t.x, t.y, k(), !1, p(n, t.x)) : t;
		}), D.current = !0) : t.mode === "move" && t.moved && v((e) => c(e, k())));
	}
	let P = {
		"--df-x": `${_.x}px`,
		"--df-y": `${_.y}px`,
		"--df-width": `${_.width}px`,
		"--df-height": `${_.height}px`
	}, F = {
		"--df-x": `${y.x}px`,
		"--df-y": `${y.y}px`
	}, I = d.stale || !!d.instanceId && !d.connected, L = !!d.sessionId && !d.stale && d.connected && !d.busy, R = f === "targets" || !d.target, z = d.activityDetail ?? d.activity?.items[0] ?? null, B = R ? {
		title: "先选择要调试的插件",
		description: "选择插件 → 让 Agent 调用调试工具 → 在这里查看过程与结果。",
		warning: !1
	} : f === "process" ? Ce(x(z), I) : {
		title: Oe[f],
		description: I ? "最后观测内容已过期，仅供只读查看。" : "当前插件的公开能力；所有修改仍按实际回执确认。",
		warning: I
	};
	async function V() {
		g("tree"), await t.action("pick", null, "", !1, !1);
	}
	function H() {
		g("data"), t.refreshDataSources();
	}
	return /* @__PURE__ */ i("div", {
		"data-deviceforge-debugger": "",
		"data-deviceforge-debugger-internal": "",
		className: "font-sans text-[#23272E]",
		children: [
			/* @__PURE__ */ r("style", { children: h }),
			/* @__PURE__ */ i("button", {
				ref: T,
				type: "button",
				"aria-label": d.open ? "收起调试器" : "打开调试器",
				"aria-expanded": d.open,
				"aria-controls": "deviceforge-debugger-panel",
				className: `${d.open ? "hidden" : "flex"} fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483001] size-12 touch-none select-none flex-col items-center justify-center rounded-full border border-white bg-[#6C4CF5] text-xs font-medium text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] focus-visible:ring-offset-2`,
				style: F,
				onPointerDown: (e) => j("ball", e),
				onPointerMove: M,
				onPointerUp: N,
				onPointerCancel: N,
				onKeyDown: (e) => {
					if (!e.altKey || !e.key.startsWith("Arrow")) return;
					e.preventDefault();
					let t = e.shiftKey ? 32 : 8;
					b((n) => u(n.x + (e.key === "ArrowRight" ? t : e.key === "ArrowLeft" ? -t : 0), n.y + (e.key === "ArrowDown" ? t : e.key === "ArrowUp" ? -t : 0), k(), !1));
				},
				onClick: () => {
					D.current ? D.current = !1 : d.open ? A() : t.open();
				},
				title: "调试器；拖动吸边，Alt + 方向键移动",
				children: [/* @__PURE__ */ r("span", {
					"aria-hidden": "true",
					children: "⌘"
				}), /* @__PURE__ */ r("span", { children: "调试" })]
			}),
			/* @__PURE__ */ i("section", {
				ref: w,
				id: "deviceforge-debugger-panel",
				role: "dialog",
				"aria-modal": "false",
				"aria-labelledby": "deviceforge-debugger-title",
				tabIndex: -1,
				hidden: !d.open || d.busy?.startsWith("拾取"),
				style: P,
				className: `${!d.open || d.busy?.startsWith("拾取") ? "hidden" : "flex"} fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483000] h-[var(--df-height)] w-[var(--df-width)] min-w-0 flex-col overflow-hidden rounded-2xl border border-[#E6EAF3] bg-white shadow-2xl outline-none`,
				onKeyDown: (e) => {
					S ? (e.key.startsWith("Arrow") && (e.preventDefault(), e.stopPropagation(), v((t) => l(t, e.key, e.shiftKey, k()))), e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), v(o(S, k())), C(null), E.current?.focus()), e.key === "Enter" && (e.preventDefault(), e.stopPropagation(), C(null), E.current?.focus())) : e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), d.busy?.startsWith("拾取") ? t.cancel() : A());
				},
				children: [
					/* @__PURE__ */ i("header", {
						className: "flex min-h-[72px] shrink-0 touch-none flex-wrap items-center gap-3 px-6 py-3 select-none",
						title: "拖动标题栏移动面板，靠近窗口边缘时吸附",
						onPointerDown: (e) => j("move", e),
						onPointerMove: M,
						onPointerUp: N,
						onPointerCancel: N,
						children: [
							/* @__PURE__ */ i("div", {
								className: "mr-auto min-w-0",
								children: [/* @__PURE__ */ r("h1", {
									id: "deviceforge-debugger-title",
									className: "truncate text-[18px] font-semibold",
									children: R ? "选择调试插件" : Oe[f]
								}), /* @__PURE__ */ r("p", {
									className: "mt-1 truncate text-xs text-[#556176]",
									children: d.target ? `${I ? "最后调试" : "正在调试"}：${d.target.pluginId} · ${d.target.kind === "server" ? "服务器插件" : "浏览器插件"}` : "在这里选择插件，无需寻找插件页面"
								})]
							}),
							/* @__PURE__ */ r("span", {
								className: `${I ? "bg-[#FDF6ED] text-[#8A4D00]" : d.connected ? "bg-[#EAF8F0] text-[#17664F]" : "bg-[#F7F8FC] text-[#556176]"} rounded-full px-4 py-1.5 text-xs`,
								children: I ? "已断开" : d.connected ? "已连接" : "待连接"
							}),
							d.target && /* @__PURE__ */ r(W, {
								soft: !0,
								onClick: () => g("targets"),
								children: "更换插件"
							}),
							/* @__PURE__ */ r(W, {
								"aria-label": "收起调试器，保留会话",
								onClick: A,
								children: "收起"
							}),
							/* @__PURE__ */ r("button", {
								type: "button",
								"aria-label": "关闭调试会话，保留悬浮入口",
								className: "size-9 rounded-lg text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
								onClick: () => {
									t.close().then(() => T.current?.focus());
								},
								children: "×"
							})
						]
					}),
					/* @__PURE__ */ i("div", {
						className: `${B.warning ? "bg-[#FDF6ED]" : "bg-[#F7F8FC]"} min-h-24 shrink-0 space-y-2 px-6 py-4`,
						children: [/* @__PURE__ */ r("h2", {
							className: `text-lg font-semibold ${B.warning ? "text-[#8A4D00]" : f === "process" && Se(x(z)).some((e) => e.status === "页面检查通过") ? "text-[#17664F]" : "text-[#23272E]"}`,
							children: B.title
						}), /* @__PURE__ */ r("p", {
							className: "text-[13px] leading-relaxed text-[#556176]",
							children: B.description
						})]
					}),
					/* @__PURE__ */ i("div", {
						className: "min-h-0 flex-1 overflow-auto p-6",
						children: [
							d.error && /* @__PURE__ */ i("div", {
								role: "alert",
								className: "mb-3 space-y-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]",
								children: [
									/* @__PURE__ */ r("p", { children: d.error.message }),
									/* @__PURE__ */ r("code", {
										className: "block break-all text-xs",
										children: d.error.code
									}),
									/* @__PURE__ */ r(X, { value: d.error.logId })
								]
							}),
							I && /* @__PURE__ */ i("div", {
								className: "mb-4 flex flex-wrap items-center gap-3 text-[13px] text-[#8A4D00]",
								children: [/* @__PURE__ */ i("span", {
									className: "mr-auto",
									children: [d.target ? "最后观测已过期；" : "调试连接已断开；", "重新连接只恢复观察，不重放先前动作。"]
								}), /* @__PURE__ */ r(W, {
									disabled: !!d.busy,
									onClick: () => void t.reconnect(!0),
									children: d.target ? "重新连接并核对目标" : "重新连接调试器"
								})]
							}),
							R ? /* @__PURE__ */ r(Z, {
								state: d,
								controller: t
							}) : /* @__PURE__ */ i(n, { children: [
								f === "process" && /* @__PURE__ */ r(we, {
									state: d,
									controller: t,
									narrow: _.width < 1040,
									onData: H,
									onInspect: () => void V(),
									onDetails: () => g("details"),
									onTargets: () => g("targets")
								}),
								f === "tree" && /* @__PURE__ */ i(n, { children: [
									/* @__PURE__ */ r("p", {
										className: "mb-4 text-sm text-[#556176]",
										children: "在页面上选择后查看简短结果；完整树和查询工具可按需展开。"
									}),
									/* @__PURE__ */ r(te, { value: d.result }),
									/* @__PURE__ */ i("details", {
										className: "mt-4 rounded-xl border border-[#E6EAF3] p-4",
										children: [/* @__PURE__ */ r("summary", {
											className: "cursor-pointer text-sm font-medium",
											children: "节点树、属性与界面检查工具"
										}), /* @__PURE__ */ r("div", {
											className: "mt-4",
											children: /* @__PURE__ */ r(re, {
												state: d,
												controller: t
											})
										})]
									})
								] }),
								f === "data" && /* @__PURE__ */ r(De, {
									state: d,
									controller: t,
									narrow: _.width < 1040
								}),
								f === "invoke" && /* @__PURE__ */ i(n, { children: [/* @__PURE__ */ r(de, {
									state: d,
									controller: t
								}), /* @__PURE__ */ r("div", {
									className: "mt-4",
									children: /* @__PURE__ */ r(te, { value: d.result })
								})] }),
								f === "details" && /* @__PURE__ */ r(Ee, {
									state: d,
									controller: t,
									context: a,
									onInvoke: () => g("invoke"),
									onResize: () => {
										C(_), E.current?.focus();
									}
								}),
								f === "report" && /* @__PURE__ */ r(ve, {
									state: d,
									controller: t,
									context: a
								})
							] })
						]
					}),
					/* @__PURE__ */ i("footer", {
						className: "relative flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-t border-[#E6EAF3] bg-[#FBFCFE] px-6 py-2 pr-10",
						children: [
							R ? /* @__PURE__ */ i(n, { children: [/* @__PURE__ */ r("p", {
								className: "mr-auto text-[13px] text-[#556176]",
								children: d.target ? "选择后切换观察目标，不会停止业务插件。" : "尚未选择插件，调试器不会读取页面。"
							}), d.target && /* @__PURE__ */ r(W, {
								onClick: () => g("process"),
								children: "返回调试过程"
							})] }) : /* @__PURE__ */ i(n, { children: [
								f === "process" ? /* @__PURE__ */ r(W, {
									soft: !0,
									disabled: !L || d.target?.kind !== "browser",
									onClick: () => void V(),
									children: "⌖ 在页面上选择"
								}) : /* @__PURE__ */ r(W, {
									soft: !0,
									onClick: () => g("process"),
									children: "← 返回调试过程"
								}),
								/* @__PURE__ */ i("details", {
									className: "relative",
									children: [/* @__PURE__ */ r("summary", {
										className: "cursor-pointer rounded-lg bg-white px-3 py-2 text-[13px] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
										children: "手动检查 ▾"
									}), /* @__PURE__ */ i("div", {
										className: "absolute bottom-full left-0 z-10 mb-2 flex min-w-40 flex-col gap-1 rounded-xl border border-[#E6EAF3] bg-white p-2 shadow-lg",
										children: [
											/* @__PURE__ */ r(W, {
												disabled: !d.target,
												onClick: () => g("tree"),
												children: "检查界面"
											}),
											/* @__PURE__ */ r(W, {
												disabled: !d.target,
												onClick: H,
												children: "查看数据"
											}),
											/* @__PURE__ */ r(W, {
												disabled: !d.target,
												onClick: () => g("invoke"),
												children: "调用公开能力"
											})
										]
									})]
								}),
								/* @__PURE__ */ r("span", { className: "mr-auto" }),
								/* @__PURE__ */ r(W, {
									onClick: () => g("details"),
									children: "技术详情 ›"
								}),
								z && /* @__PURE__ */ r(W, {
									onClick: () => g("report"),
									children: "保存报告"
								})
							] }),
							d.busy && /* @__PURE__ */ r(W, {
								onClick: () => t.cancel(),
								children: "停止等待"
							}),
							/* @__PURE__ */ r("span", {
								role: "status",
								className: "sr-only",
								children: S ? "方向键每次8像素，Shift32像素；Enter应用，Esc取消" : d.notice
							}),
							S && /* @__PURE__ */ r("button", {
								ref: E,
								type: "button",
								className: "text-[13px] text-[#6C4CF5]",
								onClick: () => C(null),
								children: "完成尺寸调整"
							}),
							/* @__PURE__ */ r("button", {
								type: "button",
								"aria-label": "拖动调整调试面板尺寸",
								className: "absolute right-0 bottom-0 flex size-7 touch-none cursor-se-resize items-center justify-center rounded-br-xl text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]",
								onPointerDown: (e) => j("resize", e),
								onPointerMove: M,
								onPointerUp: N,
								onPointerCancel: N,
								onKeyDown: (e) => {
									e.key.startsWith("Arrow") && (e.preventDefault(), v((t) => l(t, e.key, e.shiftKey, k())));
								},
								children: "╱╱"
							})
						]
					})
				]
			}),
			d.open && d.busy?.startsWith("拾取") && /* @__PURE__ */ i("div", {
				role: "status",
				className: "fixed bottom-6 left-1/2 z-[2147483001] -translate-x-1/2 rounded-full border border-[#E6EAF3] bg-white px-5 py-3 text-sm shadow-lg",
				children: ["在页面上选择元素 · Esc 取消 ", /* @__PURE__ */ r(W, {
					onClick: () => t.cancel(),
					children: "取消选择"
				})]
			})
		]
	});
}
//#endregion
//#region ../examples/browser-debugger/src/controller-data.ts
function Ae(e, t) {
	let n = R(e, t);
	if (!n || n.sourceId !== t) throw Error("插件数据回执缺少有效的源标识、修订或业务值，或来自其他数据源");
	return n;
}
function je(e) {
	return {
		refreshDataSources: () => e.run("读取数据源目录", async (t) => {
			let n = await e.tool("data_catalog", {}, t);
			e.patch({
				dataSources: L(n),
				dataNotice: y(_(n).coverage, "已读取插件主动登记的数据源；空目录不代表插件没有内部状态。")
			});
		}),
		readDataSource: (t, n = null) => e.run("读取插件数据", async (r) => {
			if (!e.snapshot().dataSources.some((e) => e.id === t)) throw Error("请先刷新并选择当前目标已登记的数据源");
			let i = Ae(await e.tool("data_read", {
				source_id: t,
				query: n
			}, r), t);
			e.patch({
				dataSnapshot: i,
				dataConflict: !1,
				dataNotice: "已读取当前数据与修订。"
			});
		}),
		writeDataSource: (t, n, r, i) => e.run("保存插件数据", async (a) => {
			if (!e.snapshot().dataSources.find((e) => e.id === t)?.writable) throw Error("当前数据源只读或尚未登记");
			if (!i) throw Error("数据写入需要明确确认本次完整替换");
			try {
				let o = Ae(await e.tool("data_write", {
					source_id: t,
					expected_revision: n,
					value: r,
					confirmed: i
				}, a), t);
				e.patch({
					dataSnapshot: o,
					dataConflict: !1,
					dataNotice: o.runtimeApplied === "pending" ? `已保存，待${o.applyPolicy === "reload" ? "重载" : "下次调用"}生效。` : "已保存并完成回读。"
				});
			} catch (t) {
				a.throwIfAborted();
				let n = w(t);
				throw /^(debugger_)?(revision_conflict|data_conflict)$/.test(n.code) ? e.patch({
					dataConflict: !0,
					dataNotice: "数据已发生变化；你的编辑已保留，请读取最新值并比较后再保存。"
				}) : e.patch({ dataNotice: n.unconfirmed ? "保存结果未确认，请读取实际状态；不会自动重放写入。" : n.message }), t;
			}
		})
	};
}
//#endregion
//#region ../examples/browser-debugger/src/controller.ts
function Me(e) {
	let t = B(e), n = new AbortController(), r = /* @__PURE__ */ new Set(), i = /* @__PURE__ */ new Set(), a = /* @__PURE__ */ new Map(), o = new AbortController(), s = 0, c = !1, l = 0, u = {
		open: !1,
		busy: null,
		connected: !1,
		stale: !1,
		instanceId: null,
		targets: [],
		target: null,
		sessionId: null,
		sessionState: "none",
		sessionCleanupSupported: !!e.debug?.registerSession,
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
		activity: null,
		activityDetail: null,
		dataSources: [],
		dataSnapshot: null,
		dataConflict: !1,
		dataNotice: null,
		requested: null,
		error: null,
		notice: "首次只显示调试入口；打开后连接，明确选择目标后才采集。",
		logId: null
	}, d = () => u;
	function f(e) {
		if (!c) {
			u = {
				...u,
				...e
			};
			for (let e of r) e();
		}
	}
	function p(e, t, n, r) {
		let i = {
			key: `local-${++l}`,
			sequence: l,
			target: u.target,
			sessionId: u.sessionId ?? "",
			level: n,
			label: e,
			logId: r,
			raw: t
		};
		f({ events: [...u.events, i].slice(-500) });
	}
	function m() {
		return o.abort(), o = new AbortController(), s++, s;
	}
	let h = () => Math.min(12e4, Math.max(45e3, b(_(u.capabilities).reload_timeout_ms, 5e4)));
	async function g(t, r, i = !1, a = 15e3) {
		if (c || e.signal.aborted) return;
		if (u.busy && !i) {
			f({ notice: `正在${u.busy}，可取消当前等待后再操作。` });
			return;
		}
		i && m();
		let l = s, d = AbortSignal.any([
			o.signal,
			n.signal,
			e.signal,
			AbortSignal.timeout(a)
		]);
		f({
			busy: t,
			error: null
		});
		try {
			await T(r(d), d);
		} catch (e) {
			if (l !== s || c) return;
			let n = w(e);
			p(t, {
				code: n.code,
				message: n.message,
				unconfirmed: n.unconfirmed
			}, "error", n.logId), f({
				error: n,
				logId: n.logId ?? u.logId,
				notice: n.unconfirmed ? "结果未确认；请查询状态，独立新操作仍可显式发起。不会自动重放。" : n.message
			}), /disconnect|inactive_session|stale_target|target_changed|wrong_instance|stale_generation/.test(n.code) && f({
				stale: !0,
				connected: !1,
				sessionState: "disconnected"
			});
		} finally {
			!c && l === s && f({ busy: null });
		}
	}
	async function S(e, n, r) {
		let i = u.sessionId;
		if (!i || !u.target) throw Error("请先明确选择调试目标并打开会话");
		if (u.stale || !u.connected) throw Error("当前为过期只读快照，请重新连接并核对目标代次");
		let a = await t.call(e, {
			session_id: i,
			parameters: n
		}, r, e === "reload" ? h() : 15e3);
		return r.throwIfAborted(), f({ logId: a.logId ?? u.logId }), a.data;
	}
	async function C(e, n) {
		let r = u.sessionId, i = u.target;
		if (!r || !i) throw Error("请先明确选择调试目标并打开会话");
		try {
			let i = await t.call("activity", {
				session_id: r,
				...e
			}, n);
			return n.throwIfAborted(), f({ logId: i.logId ?? u.logId }), i.data;
		} catch (t) {
			let r = w(t);
			if (!n.aborted && e.command_id === void 0 && /(?:capability_unavailable|tool_(?:not_found|unavailable)|unknown_tool|service_unavailable)$/.test(r.code)) return {
				target: D(i),
				items: [],
				next_before: null,
				gap: !1,
				retained_only: !0,
				unavailable: "当前后端尚不支持调试活动查询，请正常更新宿主；仍可手动检查。"
			};
			throw t;
		}
	}
	function j(e, t = !1) {
		let n = _(e), r = A(n.tree);
		if (!r) {
			let e = v(n.roots).map((e) => ({
				id: y(_(e).root_id),
				label: y(_(e).contribution_id)
			})).filter((e) => e.id);
			f({
				notice: y(n.reason, "当前目标未提供可读取的 UI 树"),
				...e.length ? { roots: e } : {}
			});
			return;
		}
		let i = u.tree, a = t && i?.id === r.id ? {
			...r,
			nodes: [...new Map([...i.nodes, ...r.nodes].map((e) => [e.id, e])).values()]
		} : r;
		f({
			tree: a,
			trees: [...u.trees.filter((e) => e.id !== a.id), a].slice(-10),
			rootId: y(n.root_id, u.rootId),
			stale: !1,
			queries: null,
			selectedNodeId: a.nodes.some((e) => e.id === u.selectedNodeId) ? u.selectedNodeId : "",
			notice: "已读取观测结构；可观测不等于可插入，DOM 存在不证明像素可见或业务成功。"
		});
	}
	function M(e) {
		let t = u.tree;
		if (!t) return;
		let n = A({
			id: t.id,
			observedAt: t.observedAt,
			nodes: v(_(e).nodes)
		});
		n && f({ tree: {
			...t,
			nodes: [...new Map([...t.nodes, ...n.nodes].map((e) => [e.id, e])).values()]
		} });
	}
	async function N(e, t) {
		let n = await S("inspect", {}, e), r = v(_(n).roots).map((e) => ({
			id: y(_(e).root_id),
			label: y(_(e).contribution_id)
		})).filter((e) => e.id);
		f({
			inspection: n,
			entries: z(n),
			roots: r,
			rootId: r.some((e) => e.id === u.rootId) ? u.rootId : r.length === 1 ? r[0]?.id ?? "" : "",
			notice: r.length > 1 ? "此目标有多个挂载根，请明确选择一个后读取 UI 树。" : "已检查公开目录与代次。"
		}), t && u.target?.kind === "browser" && r.length === 1 && j(await S("ui_tree", { root_id: r[0]?.id ?? "" }, e));
	}
	async function F(e) {
		let n = await t.call("targets", {}, e);
		e.throwIfAborted(), f({
			targets: k(n.data),
			logId: n.logId ?? u.logId
		});
	}
	async function I(e, n) {
		await t.call("session", {
			action: "close",
			session_id: e
		}, n), n.throwIfAborted(), i.delete(e);
		let r = a.get(e);
		a.delete(e), await r?.();
	}
	async function L(n) {
		await g("切换目标", async (r) => {
			let o = u.sessionId;
			f({
				target: n,
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
				activity: null,
				activityDetail: null,
				dataSources: [],
				dataSnapshot: null,
				dataConflict: !1,
				dataNotice: null,
				stale: !1,
				notice: "正在打开明确选定目标的调试会话"
			}), o && await I(o, r);
			let s = await t.call("session", {
				action: "open",
				target: D(n)
			}, r), c = _(s.data), l = y(c.session_id);
			if (l && i.add(l), l && e.debug?.registerSession && a.set(l, e.debug.registerSession(l)), r.throwIfAborted(), !l || c.state !== "active") throw Error("宿主没有返回有效活动会话");
			let d = O(c.target);
			if (!d || E(d) !== E(n)) throw Error("会话身份与明确选定目标不一致");
			f({
				sessionId: l,
				sessionState: "active",
				connected: !0,
				logId: s.logId
			}), await N(r, !1);
			let p = P(await C({ limit: 20 }, r), n), m = p.items[0], h = null;
			m && (h = P(await C({ command_id: m.commandId }, r), n).items.find((e) => e.commandId === m.commandId) ?? null), f({
				activity: p,
				activityDetail: h
			});
		}, !0);
	}
	async function R() {
		c || u.busy || !u.open || await g("核对连接", async (e) => {
			let n = await t.service("status", {}, e);
			e.throwIfAborted();
			let r = _(_(n.data).bridge), i = y(r.instanceId) || y(r.instance_id), a = r.state === "connected";
			if (f({ capabilities: n.data }), (!u.target || u.target.kind === "browser" && u.target.instanceId === u.instanceId) && (!a || i !== u.instanceId)) f({
				connected: !1,
				stale: !0,
				sessionState: "disconnected",
				notice: y(r.reason, "连接已断开或实例已更换；保留最后快照，只读查看，不自动重放。")
			});
			else if (u.sessionId) {
				let n = await t.call("session", {
					action: "get",
					session_id: u.sessionId
				}, e);
				e.throwIfAborted();
				let r = _(n.data), i = O(r.target);
				(r.state !== "active" || !i || !u.target || E(i) !== E(u.target)) && f({
					stale: !0,
					connected: !1,
					sessionState: y(r.state, "target_changed"),
					notice: "会话或目标代次已改变，最后快照已过期；请明确重新选择当前目标。"
				});
			}
		});
	}
	async function V() {
		f({ open: !0 }), await g("连接调试桥", async (e) => {
			let n = await t.service("capabilities", {}, e);
			e.throwIfAborted(), f({ capabilities: n.data });
			let r = _(_(n.data).bridge);
			if (r.state === "disconnected") {
				f({
					instanceId: y(r.instanceId) || y(r.instance_id) || u.instanceId,
					connected: !1,
					stale: !0,
					sessionState: "disconnected",
					logId: n.logId ?? u.logId,
					notice: y(r.reason, "调试桥已断开，请明确重新连接；不会自动选择目标或重放动作。")
				});
				return;
			}
			let i = await t.service("start", {}, e);
			e.throwIfAborted();
			let a = y(_(i.data).instance_id);
			if (!a) throw Error("调试桥未返回当前实例标识");
			f({
				instanceId: a,
				connected: !0,
				notice: "已连接当前浏览器实例，请明确选择浏览器插件或服务器插件。"
			}), await F(e);
		});
	}
	function H() {
		if (c) return;
		c = !0, o.abort(), n.abort(), r.clear(), e.signal.removeEventListener("abort", H);
		let s = AbortSignal.timeout(2e3), l = [...i].map((e) => {
			let n = a.get(e);
			return n ? Promise.resolve(n()) : t.call("session", {
				action: "close",
				session_id: e
			}, s);
		});
		return i.clear(), a.clear(), T(Promise.allSettled(l), s).then(() => void 0, () => void 0);
	}
	return e.signal.addEventListener("abort", H, { once: !0 }), e.signal.aborted && H(), {
		snapshot: d,
		subscribe(e) {
			return r.add(e), () => {
				r.delete(e);
			};
		},
		open: V,
		collapse() {
			f({ open: !1 });
		},
		cancel() {
			m(), f({
				busy: null,
				notice: "已取消当前等待；已派发副作用结果未确认，不会自动重放。"
			});
		},
		select: L,
		checkConnection: R,
		refreshTargets: () => g("刷新目标目录", F),
		refreshActivity: (e) => u.busy ? Promise.resolve() : g("读取调试调用", async (t) => {
			let n = P(await C({
				limit: 20,
				...e === void 0 ? {} : { before: e }
			}, t), u.target), r = u.activity, i = e !== void 0 && r ? [...r.items, ...n.items.filter((e) => !r.items.some((t) => t.commandId === e.commandId))] : n.items, a = u.activityDetail;
			e === void 0 && n.items[0] && (a = P(await C({ command_id: n.items[0].commandId }, t), u.target).items.find((e) => e.commandId === n.items[0]?.commandId) ?? null), f({
				activity: {
					...n,
					items: i
				},
				activityDetail: a,
				notice: n.gap ? "调试调用历史存在淘汰缺口；仅展示当前仍保留的公开记录。" : "调试调用记录已更新。"
			});
		}),
		selectActivity: (e) => g("读取调试调用结果", async (t) => {
			if (!e.trim()) throw Error("请选择要查看的调试调用");
			let n = P(await C({ command_id: e }, t), u.target).items.find((t) => t.commandId === e);
			if (!n) throw Error("找不到当前目标的调试调用记录");
			f({
				activityDetail: n,
				notice: n.response === null ? "该调用尚无可展示的最终回执。" : "已读取原调试调用回执；不会重新派发动作。"
			});
		}),
		...je({
			snapshot: d,
			patch: f,
			run: g,
			tool: S
		}),
		async requestTargets(e, t = null) {
			e.length && (f({
				requested: {
					candidates: e,
					installationId: t
				},
				open: !0
			}), u.instanceId ? await g("带入市场目标", F, !0) : await V(), f({ notice: `市场已带入 ${e.length} 个候选组件，请核对实例、组件和代次后明确选择。` }));
		},
		clearRequested() {
			f({ requested: null });
		},
		reconnect: (e) => g("显式重新连接", async (n) => {
			if (!e) throw Error("重连将创建新浏览器实例，请先明确确认");
			let r = await t.service("reconnect", { input: { confirmed: e } }, n);
			n.throwIfAborted();
			let i = y(_(r.data).instance_id);
			if (!i || i === u.instanceId) throw Error("重连尚未返回不同的新实例，请核对桥状态");
			f({
				instanceId: i,
				connected: !0,
				stale: !!u.target,
				sessionState: "disconnected",
				notice: "新实例已建立；旧快照仍过期。请明确选择当前插件新代，会话与原动作不自动重放。"
			}), await F(n);
		}, !0),
		installation: () => g("查询安装与运行修订", async (e) => {
			let n = await t.service("installation", {}, e);
			e.throwIfAborted(), f({
				installation: n.data,
				logId: n.logId
			});
		}),
		logs: (e, n) => g("搜索服务器公共日志", async (r) => {
			let i = {
				order: "desc",
				...n ? { log_id: e.trim() } : { q: e.trim() }
			}, a = await t.service("logs", { input: i }, r);
			r.throwIfAborted(), f({
				logs: a.data,
				logId: a.logId,
				notice: _(a.data).limited === !0 ? "日志搜索已受限截断；结果不是完整日志。" : "已读取服务器公共日志。"
			});
		}),
		refreshInspection: () => g("检查目标", (e) => N(e, !1)),
		async close() {
			await g("关闭调试会话", async (e) => {
				u.sessionId && await I(u.sessionId, e), f({
					open: !1,
					sessionId: null,
					sessionState: "closed",
					stale: !!u.target,
					notice: "调试会话已关闭；业务插件与任务继续由原入口管理。"
				});
			}, !0);
		},
		setRoot(e) {
			u.roots.some((t) => t.id === e) && (m(), f({
				rootId: e,
				tree: null,
				trees: [],
				selectedNodeId: "",
				queries: null,
				busy: null
			}));
		},
		setNode(e) {
			u.tree?.nodes.some((t) => t.id === e) && f({ selectedNodeId: e });
		},
		tree: () => g("读取 UI 树", async (e) => {
			if (u.roots.length > 1 && !u.rootId) throw Error("请先明确选择挂载根");
			j(await S("ui_tree", u.rootId ? { root_id: u.rootId } : {}, e));
		}),
		nextTreePage: () => g("读取下一页节点", async (e) => {
			let t = u.tree, n = _(_(t?.raw).page);
			t && typeof n.nextOffset == "number" && j(await S("ui_tree", {
				root_id: u.rootId,
				snapshot_id: t.id,
				offset: n.nextOffset,
				limit: 500
			}, e), !0);
		}),
		overview: (e = 0) => g("读取公开挂载目录", async (t) => {
			f({
				overview: await S("ui_tree", {
					view: "overview",
					offset: e,
					limit: 100
				}, t),
				notice: "公开目录不代表页面已实例化；未挂载条目不生成 DOM 树。"
			});
		}),
		query: (e) => g("语义查询", async (t) => {
			let n = await S("ui_query", {
				root_id: u.rootId,
				query: e
			}, t);
			M(n), f({
				queries: v(_(n).nodes).map((e) => y(_(e).id)),
				result: n,
				notice: y(_(n).reason, "语义查询已完成；不完整观测不能证明节点不存在。")
			});
		}),
		clearQuery() {
			f({ queries: null });
		},
		navigate: (e, t) => g("导航到公开路由", async (n) => {
			if (!t) throw Error("导航需要本次显式确认");
			let r = await S("ui_action", { action: {
				type: "navigate",
				path: e,
				confirmed: t
			} }, n);
			f({
				result: r,
				notice: y(_(r).reason, "已请求导航，未证明页面或业务完成。")
			});
		}),
		assertion: (e) => g("执行结构断言", async (t) => {
			let n = await S("ui_assert", {
				root_id: u.rootId,
				assertion: e
			}, t);
			f({
				result: n,
				notice: `断言 ${y(_(n).status, "结果未知")}：${y(_(n).reason)}`
			});
		}),
		diff: (e, t) => g("比较快照", async (n) => {
			let r = await S("ui_diff", {
				root_id: u.rootId,
				before_id: e,
				after_id: t
			}, n);
			f({
				result: r,
				notice: y(_(r).reason, "已比较选定挂载根的两个快照。")
			});
		}),
		action: (e, t, n, r, i) => g(e === "pick" ? "拾取节点（Esc 取消）" : "执行节点动作", async (a) => {
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
			let s = await S("ui_action", {
				...u.rootId && e !== "pick" ? { root_id: u.rootId } : {},
				action: o
			}, a);
			if (f({
				result: s,
				notice: y(_(s).reason, "已收到节点动作回执；业务结果仍需核对。")
			}), p(`节点动作 ${e}`, s, "info", u.logId), e === "pick") {
				let e = _(s), t = _(e.owner), n = _(e.target);
				if (e.status === "picked" && t.pluginId === u.target?.pluginId && String(t.generation) === u.target?.generation) {
					let t = y(e.root_id);
					t && f({ rootId: t }), j(await S("ui_tree", t ? { root_id: t } : {}, a)), !u.tree?.nodes.some((e) => e.id === n.id) && y(n.id) && M(await S("ui_query", {
						root_id: u.rootId,
						query: {
							id: y(n.id),
							limit: 1
						}
					}, a)), u.tree?.nodes.some((e) => e.id === n.id) && f({ selectedNodeId: y(n.id) });
				} else e.source === "host-dom" ? f({
					selectedNodeId: "",
					notice: "已拾取宿主普通节点，仅展示只读身份；普通节点不能作为插件动作目标或插入槽位。"
				}) : e.status === "picked" && f({ notice: "拾取到其他插件，仅展示归属；请明确切换目标后再查看。" });
			}
		}),
		invoke: (e, t, n, r, i = !1) => g("试调用公开入口", async (a) => {
			if (!u.entries.some((t) => t.key === e.key) || !e.available) throw Error("调用入口不在当前目标目录中");
			if (!n || !r) throw Error("试调用需要分别确认本次调用和未知副作用");
			let o = {
				kind: e.kind,
				id: e.id,
				input: t,
				confirmed: n,
				allow_unknown_side_effects: r
			};
			u.target?.kind === "browser" && (o.include_result = i), e.version && (o.version = e.version);
			let s = await S("invoke", o, a);
			f({
				result: s,
				notice: "已收到调用回执；已接受或已派发不代表原业务完成，请核对原任务。"
			}), p(`试调用 ${e.id}`, s, "info", u.logId);
		}),
		reload: (e) => g("重载选定插件", async (t) => {
			let n = u.target;
			if (!n || !e) throw Error("请明确确认当前插件 ID 和代次后重载");
			let r = await S("reload", { confirmed: !0 }, t);
			f({ result: r }), p("插件重载", r, "info", u.logId), await F(t);
			let i = u.targets.find((e) => e.kind === n.kind && e.instanceId === n.instanceId && e.pluginId === n.pluginId);
			f({
				stale: !0,
				sessionState: "target_changed",
				notice: i?.generation && i.generation !== n.generation ? `已核到新代 ${i.generation}；请明确选择新代后继续观测，不重放原动作。` : "尚未核到不同的新代；请刷新目标目录检查结果，不自动重载或重放。"
			});
		}, !1, h()),
		events: () => g("读取下一页事件", async (e) => {
			let n = u.sessionId;
			if (!n) throw Error("请先选择调试会话；断线时可查看已缓存历史");
			let r = await t.call("events", {
				session_id: n,
				after: u.cursor,
				limit: 100
			}, e);
			e.throwIfAborted();
			let i = _(r.data), a = v(i.events).map((e) => {
				let t = _(e), i = y(t.command_state) || y(t.session_state);
				return {
					key: `${n}:${b(t.sequence)}`,
					sequence: b(t.sequence),
					target: u.target,
					sessionId: n,
					level: /failed|unconfirmed|disconnected/.test(i) ? "error" : "info",
					label: `${y(t.kind)} ${i}`.trim(),
					logId: y(t.log_id) || r.logId,
					raw: x(e)
				};
			});
			f({
				events: [...new Map([...u.events, ...a].map((e) => [e.key, e])).values()].slice(-500),
				cursor: b(i.next_after, u.cursor),
				eventGap: i.gap === !0,
				droppedEvents: b(i.dropped_events),
				logId: r.logId,
				notice: i.gap === !0 ? "事件游标存在缺口；请保留截断提示，不据此推断没有发生事件。" : "事件分页已更新。"
			});
		}),
		report: (e = !1, t = "json") => g("汇总调试报告", async (n) => {
			let r = await S("report", { export: e ? t : "none" }, n);
			f({
				report: r,
				notice: _(r).artifact ? "宿主已返回报告产物；可通过公开产物入口下载。" : "已汇总内存证据，可下载本地 JSON / Markdown；不是完整生产验收。"
			});
		}),
		reportNext: () => g("读取报告快照续页", async (e) => {
			let t = _(u.report), n = _e(u.report);
			if (!n) throw Error("报告没有可读取的快照续页");
			let r = _(await S("ui_tree", {
				root_id: n.rootId,
				snapshot_id: n.snapshotId,
				offset: n.offset,
				limit: 500
			}, e));
			if (!A(r.tree)) throw Error("报告快照续页未返回有效结构树");
			f({
				report: x({
					...t,
					ui_snapshot_pages: [...v(t.ui_snapshot_pages), r]
				}),
				notice: "已读取指定快照续页；报告仍保留分页与不完整观测说明。"
			});
		}),
		dispose: H
	};
}
//#endregion
//#region ../examples/browser-debugger/src/index.tsx
var Ne = {
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
			let a = Me(n), o = t(i);
			o.render(/* @__PURE__ */ r(ke, {
				controller: a,
				context: n
			}));
			let s = n.extensions?.subscribeEvent("host.debugger.target_requested", (e) => {
				let t = _(e.data), n = (Array.isArray(t.candidates) ? v(t.candidates) : [t]).map((e) => ({
					kind: y(_(e).target_kind),
					pluginId: y(_(e).plugin_id)
				})).filter((e) => (e.kind === "browser" || e.kind === "server") && e.pluginId);
				a.requestTargets(n, y(t.installation_id) || null);
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
export { Ne as default };

//# sourceMappingURL=index.js.map