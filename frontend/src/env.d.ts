/// <reference types="vite/client" />
declare module '*.svelte' {
  const component: import('svelte').Component;
  export default component;
}
