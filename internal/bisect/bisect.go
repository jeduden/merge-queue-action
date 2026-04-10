package bisect

// Split divides a list of PR numbers into two halves for binary bisection.
// Left half gets the first ceil(n/2) elements, right half gets the rest.
// Returns (left, right). If len(prs) <= 1, right is nil.
func Split(prs []int) (left, right []int) {
	if len(prs) == 0 {
		return nil, nil
	}
	if len(prs) == 1 {
		return prs, nil
	}
	mid := (len(prs) + 1) / 2
	return prs[:mid], prs[mid:]
}
