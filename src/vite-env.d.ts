/// <reference types="vite/client" />

declare module "epubjs" {
  interface Rendition {
    display(cfi?: string): Promise<void>;
    next(): Promise<void>;
    prev(): Promise<void>;
    on(event: string, cb: (value: unknown) => void): void;
    themes: {
      fontSize(s: string): void;
      select(name: string): void;
      register(name: string, styles: Record<string, unknown>): void;
    };
    destroy(): void;
  }
  interface Book {
    renderTo(el: Element, options?: Record<string, unknown>): Rendition;
    destroy(): void;
  }
  function Epub(url: string): Book;
  export default Epub;
}

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_GOOGLE_CLIENT_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
