/**
 * Okapi BM25 over a run's reference packet: which saved excerpts a task's words
 * point to. Local, deterministic and cheap, so retrieval needs no embeddings
 * model and no extra inference.
 */

const K1 = 1.2;
const B = 0.75;

/** Words of two or more letters or digits, lower-cased; the stop words carry no signal. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !STOP.has(word));
}

/** The documents' indexes by score for the query, best first, those with any match only. */
export function rank(query: string, documents: string[]): Array<{ index: number; score: number }> {
  const docs = documents.map(terms);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const frequency = new Map<string, number>();
  for (const doc of docs)
    for (const word of new Set(doc)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const wanted = [...new Set(terms(query))];
  return docs
    .map((doc, index) => {
      const counts = new Map<string, number>();
      for (const word of doc) counts.set(word, (counts.get(word) ?? 0) + 1);
      let score = 0;
      for (const word of wanted) {
        const count = counts.get(word);
        if (!count) continue;
        const holding = frequency.get(word) ?? 0;
        const idf = Math.log(1 + (docs.length - holding + 0.5) / (holding + 0.5));
        score += (idf * count * (K1 + 1)) / (count + K1 * (1 - B + (B * doc.length) / average));
      }
      return { index, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how if in into is it its no not of on or so such than that the their then there these they this to was we were what when where which while who will with you your".split(
    " ",
  ),
);
