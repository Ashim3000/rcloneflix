/**
 * Immersion Reading & Read-Along Engine (Storyteller-grade EPUB & Audiobook Sync)
 *
 * Provides:
 * 1. Microsecond-accurate sentence highlighting for EPUB 3 Media Overlays (SMIL).
 * 2. Intelligent real-time sentence/paragraph segmentation and karaoke highlighting
 *    for standard EPUB + Audiobook pairs that lack pre-compiled SMIL overlays.
 * 3. Automatic page turning when the narrator advances past the visible viewport.
 * 4. Tap/click-to-seek: clicking any sentence in the reader immediately seeks companion audio.
 * 5. Decoupled architecture: operates directly on iframe DOM nodes with zero React re-render overhead.
 */

import type { SmilPar } from "./smilParser";

export interface AudioTickDetail {
  currentTime: number;
  duration: number;
  chapterIndex: number;
  chapterStart: number;
  chapterEnd: number;
  chapterTitle?: string;
  playing: boolean;
}

export interface ReadAlongSentenceNode {
  element: HTMLElement;
  startWordIndex: number;
  endWordIndex: number;
  wordCount: number;
  startRatio: number;
  endRatio: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export class ReadAlongEngine {
  private activeElement: HTMLElement | null = null;
  private currentDoc: Document | null = null;
  private currentWindow: Window | null = null;
  private currentContents: any = null;
  private currentChapterHref: string = "";
  private currentChapterIndex: number = -1;
  private currentChapterTitle: string = "";
  private totalChapters: number = 0;
  private rendition: any = null;
  private smilPars: SmilPar[] = [];
  private sentenceNodes: ReadAlongSentenceNode[] = [];
  private totalWords: number = 0;
  private lastPageTurnTimestamp: number = 0;
  private isAutoTurning: boolean = false;
  private enabled: boolean = true;

  constructor(rendition: any) {
    this.rendition = rendition;
  }

  public setEnabled(val: boolean) {
    this.enabled = val;
    if (!val && this.activeElement) {
      this.activeElement.classList.remove("rcloneflix-readalong-active");
      this.activeElement = null;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Attaches to an epubjs iframe Contents object when a new chapter section is loaded.
   */
  public attachContents(
    contents: any,
    chapterHref: string,
    chapterSmilPars?: SmilPar[],
    chapterIndex?: number,
    chapterTitle?: string,
    totalChapters?: number
  ) {
    if (!contents || !contents.document) return;

    this.currentContents = contents;
    const doc = contents.document as Document;
    this.currentDoc = doc;
    this.currentWindow = contents.window || window;
    this.currentChapterHref = chapterHref.split("/").pop() || chapterHref;
    this.currentChapterIndex = typeof chapterIndex === "number" ? chapterIndex : -1;
    this.currentChapterTitle = chapterTitle || "";
    this.totalChapters = typeof totalChapters === "number" ? totalChapters : 0;
    this.smilPars = chapterSmilPars || [];
    this.sentenceNodes = [];
    this.totalWords = 0;
    this.activeElement = null;

    this.injectStyles(doc);

    if (this.smilPars.length > 0) {
      this.setupSmilMode(doc, this.smilPars);
    } else {
      this.setupDynamicSegmentation(doc);
    }
  }

  /**
   * Injects CSS classes for active amber highlight pill and interactive sentence clicking.
   */
  private injectStyles(doc: Document) {
    const styleId = "rcloneflix-readalong-style";
    if (doc.getElementById(styleId)) return;

    const style = doc.createElement("style");
    style.id = styleId;
    style.textContent = `
      .rcloneflix-readalong-active {
        background-color: rgba(245, 158, 11, 0.32) !important;
        border-bottom: 2px solid #f59e0b !important;
        border-radius: 4px !important;
        padding: 1px 3px !important;
        margin: 0 -1px !important;
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.18) !important;
        transition: background-color 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s ease !important;
      }
      .rcloneflix-readalong-clickable {
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .rcloneflix-readalong-clickable:hover {
        background-color: rgba(245, 158, 11, 0.14) !important;
        border-radius: 3px;
      }
    `;
    doc.head.appendChild(style);
  }

  /**
   * Configures SMIL Media Overlays mode for books with pre-compiled alignment.
   */
  private setupSmilMode(doc: Document, pars: SmilPar[]) {
    for (const par of pars) {
      if (!par.elementId) continue;
      const elem = doc.getElementById(par.elementId);
      if (elem) {
        elem.classList.add("rcloneflix-readalong-clickable");
        elem.setAttribute("data-clip-begin", String(par.clipBegin));
        elem.setAttribute("data-clip-end", String(par.clipEnd));

        elem.addEventListener("click", (e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("rcloneflix:whispersync-seek-audio", {
              detail: { time: par.clipBegin },
            })
          );
        });
      }
    }
  }

  /**
   * Dynamically segments paragraphs into sentences with word-count offsets and pacing rates
   * for standard EPUBs that lack pre-generated SMIL files.
   */
  private setupDynamicSegmentation(doc: Document) {
    const textContainers = doc.querySelectorAll("p, blockquote, li, h1, h2, h3, h4, h5, h6");
    if (textContainers.length === 0) return;

    type RawSentence = {
      text: string;
      wordCount: number;
      charLength: number;
    };

    type CandidateParagraph = {
      elem: HTMLElement;
      sentences: RawSentence[];
    };

    let totalWords = 0;
    let totalChars = 0;
    const candidates: CandidateParagraph[] = [];

    // 1. DOM Inspection: Extract leaf paragraphs & sentence boundaries
    textContainers.forEach((node) => {
      const el = node as HTMLElement;
      // Skip parent containers containing child paragraphs or headings to prevent duplicate segmentation
      if (el.querySelector("p, blockquote, li, h1, h2, h3, h4, h5, h6")) return;

      const text = el.textContent || "";
      if (!text.trim()) return;

      // Split into sentences using punctuation boundaries (. ! ? followed by whitespace or quotes)
      const regex = /[^.!?]+(?:[.!?]+["'”’]?|\s*$)/g;
      const matches = Array.from(text.matchAll(regex));

      const pSentences: RawSentence[] = [];
      if (matches.length <= 1) {
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        if (words > 0) {
          pSentences.push({ text, wordCount: words, charLength: text.length });
          totalWords += words;
          totalChars += text.length;
        }
      } else {
        for (const m of matches) {
          const sText = m[0];
          if (!sText || !sText.trim()) continue;
          const words = sText.trim().split(/\s+/).filter(Boolean).length;
          if (words > 0) {
            pSentences.push({ text: sText, wordCount: words, charLength: sText.length });
            totalWords += words;
            totalChars += sText.length;
          }
        }
      }

      if (pSentences.length > 0) {
        candidates.push({ elem: el, sentences: pSentences });
      }
    });

    if (totalWords === 0) return;
    this.totalWords = totalWords;

    // 2. Cumulative Word Offsets and Sentence Wrapping
    let runningWords = 0;
    let runningChars = 0;
    const sentenceNodes: ReadAlongSentenceNode[] = [];

    for (const para of candidates) {
      const el = para.elem;
      const sentences = para.sentences;

      // If only 1 sentence or element contains styled child nodes (em, i, strong, a):
      // Don't wipe out child elements; treat element as a single readalong unit
      if (sentences.length === 1 || el.children.length > 0) {
        const s = sentences.reduce(
          (acc, cur) => ({
            text: acc.text + cur.text,
            wordCount: acc.wordCount + cur.wordCount,
            charLength: acc.charLength + cur.charLength,
          }),
          { text: "", wordCount: 0, charLength: 0 }
        );
        const wStart = runningWords;
        const wEnd = runningWords + s.wordCount;
        const cStart = runningChars;
        const cEnd = runningChars + s.charLength;
        runningWords = wEnd;
        runningChars = cEnd;

        el.classList.add("rcloneflix-readalong-clickable");
        el.setAttribute("data-word-start", String(wStart));
        el.setAttribute("data-word-end", String(wEnd));

        const nodeEntry: ReadAlongSentenceNode = {
          element: el,
          startWordIndex: wStart,
          endWordIndex: wEnd,
          wordCount: s.wordCount,
          startRatio: wStart / totalWords,
          endRatio: wEnd / totalWords,
          charStart: cStart,
          charEnd: cEnd,
          text: s.text,
        };
        sentenceNodes.push(nodeEntry);

        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.dispatchRatioSeek(nodeEntry.startRatio);
        });
      } else {
        // Pure text node paragraph: split into interactive sentence spans
        const frag = doc.createDocumentFragment();

        for (const s of sentences) {
          const wStart = runningWords;
          const wEnd = runningWords + s.wordCount;
          const cStart = runningChars;
          const cEnd = runningChars + s.charLength;
          runningWords = wEnd;
          runningChars = cEnd;

          const span = doc.createElement("span");
          span.className = "rcloneflix-readalong-clickable";
          span.textContent = s.text;
          span.setAttribute("data-word-start", String(wStart));
          span.setAttribute("data-word-end", String(wEnd));

          const nodeEntry: ReadAlongSentenceNode = {
            element: span,
            startWordIndex: wStart,
            endWordIndex: wEnd,
            wordCount: s.wordCount,
            startRatio: wStart / totalWords,
            endRatio: wEnd / totalWords,
            charStart: cStart,
            charEnd: cEnd,
            text: s.text,
          };
          sentenceNodes.push(nodeEntry);

          span.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dispatchRatioSeek(nodeEntry.startRatio);
          });

          frag.appendChild(span);
        }

        while (el.firstChild) {
          el.removeChild(el.firstChild);
        }
        el.appendChild(frag);
      }
    }

    this.sentenceNodes = sentenceNodes;
  }

  private dispatchRatioSeek(ratio: number) {
    window.dispatchEvent(
      new CustomEvent("rcloneflix:whispersync-seek-to-ratio", {
        detail: {
          ratio,
          chapterHref: this.currentChapterHref,
          chapterIndex: this.currentChapterIndex,
          chapterTitle: this.currentChapterTitle,
          totalChapters: this.totalChapters,
        },
      })
    );
  }

  /**
   * Called on every audio tick from AudioMiniPlayer.
   * Dynamically tracks narrator's cumulative word progress and highlights the current sentence pill.
   */
  public onAudioTick(detail: AudioTickDetail) {
    if (!this.enabled || !this.currentDoc) return;

    let targetElement: HTMLElement | null = null;

    if (this.smilPars.length > 0) {
      // 1. SMIL Media Overlays Mode (exact alignment timestamps)
      const cur = detail.currentTime;
      const match = this.smilPars.find((p) => cur >= p.clipBegin && cur < p.clipEnd);
      if (match?.elementId) {
        targetElement = this.currentDoc.getElementById(match.elementId);
      }
    } else if (this.sentenceNodes.length > 0) {
      // 2. Dynamic Word-Count Pacing Mode (Zero Transcoding Needed)
      let ratio = 0;
      if (detail.chapterEnd > detail.chapterStart && (detail.chapterEnd - detail.chapterStart) > 1) {
        // We have distinct chapter start & end from M4B or ID3 tags
        const chDur = detail.chapterEnd - detail.chapterStart;
        const elapsedSec = Math.max(0, detail.currentTime - detail.chapterStart);
        ratio = Math.max(0, Math.min(1, elapsedSec / chDur));
      } else if (detail.duration > 0 && this.totalChapters > 1 && this.currentChapterIndex >= 0) {
        // Single unchaptered file: scale overall audio time against EPUB TOC chapters
        const overallRatio = Math.max(0, Math.min(1, detail.currentTime / detail.duration));
        const chSpan = 1 / this.totalChapters;
        const chStartRatio = this.currentChapterIndex * chSpan;
        ratio = Math.max(0, Math.min(1, (overallRatio - chStartRatio) / chSpan));
      } else if (detail.duration > 0) {
        ratio = Math.max(0, Math.min(1, detail.currentTime / detail.duration));
      }

      // Calculate current cumulative word offset
      const currentWord = Math.floor(ratio * this.totalWords);

      // Locate sentence containing current word index
      const match =
        this.sentenceNodes.find(
          (s) => currentWord >= s.startWordIndex && currentWord < s.endWordIndex
        ) ||
        this.sentenceNodes.find(
          (s) => ratio >= s.startRatio && ratio < s.endRatio
        );

      if (match) {
        targetElement = match.element;
      } else if (ratio >= 0.99 && this.sentenceNodes.length > 0) {
        targetElement = this.sentenceNodes[this.sentenceNodes.length - 1].element;
      }
    }

    if (targetElement && targetElement !== this.activeElement) {
      if (this.activeElement) {
        this.activeElement.classList.remove("rcloneflix-readalong-active");
      }
      targetElement.classList.add("rcloneflix-readalong-active");
      this.activeElement = targetElement;

      // Auto Page Turn check
      this.checkViewportPagination(targetElement);
    }
  }

  /**
   * Inspects the active sentence's position within the iframe column viewport.
   * Automatically turns to the next page when the narrator advances past the visible viewport.
   */
  private checkViewportPagination(elem: HTMLElement) {
    if (!this.rendition || !this.currentWindow || this.isAutoTurning) return;

    const now = Date.now();
    // Debounce auto page turns to at least 900ms to prevent rapid flip stutter
    if (now - this.lastPageTurnTimestamp < 900) return;

    try {
      const rect = elem.getBoundingClientRect();
      const winWidth = this.currentWindow.innerWidth;
      const winHeight = this.currentWindow.innerHeight;

      // In horizontal paginated column view:
      if (rect.left >= winWidth - 10) {
        this.isAutoTurning = true;
        this.lastPageTurnTimestamp = now;

        if (this.currentContents && typeof this.currentContents.cfiFromNode === "function") {
          try {
            const cfi = this.currentContents.cfiFromNode(elem);
            if (cfi) {
              this.rendition
                .display(cfi)
                .catch(() => this.rendition.next().catch(() => {}))
                .finally(() => {
                  setTimeout(() => {
                    this.isAutoTurning = false;
                  }, 400);
                });
              return;
            }
          } catch {}
        }

        this.rendition
          .next()
          .catch(() => {})
          .finally(() => {
            setTimeout(() => {
              this.isAutoTurning = false;
            }, 400);
          });
      } else if (rect.right <= 10) {
        this.isAutoTurning = true;
        this.lastPageTurnTimestamp = now;
        this.rendition
          .prev()
          .catch(() => {})
          .finally(() => {
            setTimeout(() => {
              this.isAutoTurning = false;
            }, 400);
          });
      } else if (rect.top > winHeight - 30 || rect.bottom < 30) {
        // Continuous scrolled view fallback
        elem.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch {
      // Fallback
    }
  }

  public destroy() {
    if (this.activeElement) {
      this.activeElement.classList.remove("rcloneflix-readalong-active");
      this.activeElement = null;
    }
    this.currentDoc = null;
    this.currentWindow = null;
    this.currentContents = null;
    this.sentenceNodes = [];
    this.smilPars = [];
    this.totalWords = 0;
  }
}
