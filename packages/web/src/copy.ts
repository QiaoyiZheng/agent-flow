// Copy to the clipboard: code blocks in rendered Markdown (their Copy button), tool output, replies, paths.

/**
 * Put text on the clipboard; true when it worked. The clipboard API needs a secure context (127.0.0.1 is one; a page
 * opened through another host name may not be): then the old way, through a hidden text box.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

/** The Copy button of a code block in rendered Markdown (markdown.ts draws it). */
export const CODE_COPY_BUTTON = `<button type="button" class="code-copy" title="Copy this code">Copy</button>`;

/** A click in rendered Markdown: if it is on a code block's Copy button, copy the code. True when it was. */
export function copyCodeClick(target: EventTarget | null): boolean {
  const b = (target as HTMLElement | null)?.closest?.(".code-copy") as HTMLButtonElement | null;
  if (!b) return false;
  const pre = b.closest(".code-block")?.querySelector("pre");
  void copyText(pre?.textContent ?? "").then((ok) => {
    b.textContent = ok ? "Copied" : "Failed";
    b.classList.add(ok ? "done" : "failed");
    setTimeout(() => {
      b.textContent = "Copy";
      b.classList.remove("done", "failed");
    }, 1500);
  });
  return true;
}
