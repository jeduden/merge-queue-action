package bisect

import (
	"testing"

	"slices"
)

func TestSplit(t *testing.T) {
	tests := []struct {
		name  string
		input []int
		left  []int
		right []int
	}{
		{
			name:  "empty",
			input: nil,
			left:  nil,
			right: nil,
		},
		{
			name:  "single",
			input: []int{1},
			left:  []int{1},
			right: nil,
		},
		{
			name:  "two elements",
			input: []int{1, 2},
			left:  []int{1},
			right: []int{2},
		},
		{
			name:  "three elements",
			input: []int{1, 2, 3},
			left:  []int{1, 2},
			right: []int{3},
		},
		{
			name:  "four elements",
			input: []int{10, 20, 30, 40},
			left:  []int{10, 20},
			right: []int{30, 40},
		},
		{
			name:  "five elements",
			input: []int{1, 2, 3, 4, 5},
			left:  []int{1, 2, 3},
			right: []int{4, 5},
		},
		{
			name:  "six elements",
			input: []int{1, 2, 3, 4, 5, 6},
			left:  []int{1, 2, 3},
			right: []int{4, 5, 6},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			left, right := Split(tt.input)
			if !slices.Equal(left, tt.left) {
				t.Errorf("left = %v, want %v", left, tt.left)
			}
			if !slices.Equal(right, tt.right) {
				t.Errorf("right = %v, want %v", right, tt.right)
			}
		})
	}
}
