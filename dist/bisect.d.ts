/**
 * Split divides a list of PR numbers into two halves for binary bisection.
 * Left half gets the first ceil(n/2) elements, right half gets the rest.
 */
export declare function split(prs: number[]): [number[], number[]];
