/** 生成的模块没有导入时 DOM 副作用；调用方将释放函数登记到插件生命周期。 */
export declare function stylesModule(css: readonly string[]): string;
export declare const stylesDeclaration = "export declare const styleUrls: readonly string[];\nexport declare function acquireStyles(document: Document): () => void;\n";
