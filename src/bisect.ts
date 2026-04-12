/**
 * Split divides a list of PR numbers into two halves for binary bisection.
 * Left half gets the first ceil(n/2) elements, right half gets the rest.
 */
export function split(prs: number[]): [number[], number[]] {
  if (prs.length <= 1) return [[...prs], []];
  const mid = Math.ceil(prs.length / 2);
  return [prs.slice(0, mid), prs.slice(mid)];
}
