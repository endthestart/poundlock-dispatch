/** The words of a text: runs of non-space characters. */
export function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}
