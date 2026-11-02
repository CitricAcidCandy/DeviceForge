/** 生成的模块没有导入时 DOM 副作用；调用方将释放函数登记到插件生命周期。 */
export function stylesModule(css: readonly string[]): string {
  return `export const styleUrls = Object.freeze([${css.map((path) => `new URL(${JSON.stringify(`./${path}`)}, import.meta.url).href`).join(', ')}]);
const documents = new WeakMap();
export function acquireStyles(document) {
  if (!document || document.nodeType !== 9 || !document.head) throw new Error("插件样式需要实际 Document");
  let state = documents.get(document);
  if (!state) {
    const links = [];
    try {
      for (const href of styleUrls) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.setAttribute("data-deviceforge-plugin-style", "");
        links.push(link);
        document.head.append(link);
      }
    } catch (error) { for (const link of links) link.remove(); throw error; }
    state = { references: 0, links };
    documents.set(document, state);
  }
  state.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.references--;
    if (state.references === 0) {
      for (const link of state.links) link.remove();
      if (documents.get(document) === state) documents.delete(document);
    }
  };
}
`;
}
export const stylesDeclaration = `export declare const styleUrls: readonly string[];
export declare function acquireStyles(document: Document): () => void;
`;
