package main

import "testing"

func TestHasWritePermission(t *testing.T) {
	tests := []struct {
		perm string
		want bool
	}{
		{"admin", true},
		{"maintain", true},
		{"write", true},
		{"triage", false},
		{"read", false},
		{"none", false},
		{"", false},
	}
	for _, tt := range tests {
		got := hasWritePermission(tt.perm)
		if got != tt.want {
			t.Errorf("hasWritePermission(%q) = %v, want %v", tt.perm, got, tt.want)
		}
	}
}
