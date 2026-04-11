package main

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "merge-queue")
	build := exec.Command("go", "build",
		"-ldflags", "-X main.Version=v1.2.3-test -X main.CommitHash=abc1234",
		"-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		t.Fatalf("version: %v", err)
	}

	want := "merge-queue v1.2.3-test (abc1234)\n"
	if string(out) != want {
		t.Errorf("got %q, want %q", string(out), want)
	}
}

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
