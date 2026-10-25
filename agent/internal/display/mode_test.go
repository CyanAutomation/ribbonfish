package display

import "testing"

func TestParseMode(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    ModeSpec
		wantErr bool
	}{
		{name: "empty defaults to preferred", want: ModeSpec{Preferred: true}},
		{name: "preferred", value: "preferred", want: ModeSpec{Preferred: true}},
		{name: "resolution", value: "1920x1080", want: ModeSpec{Width: 1920, Height: 1080}},
		{name: "resolution and refresh", value: "1280x720@60", want: ModeSpec{Width: 1280, Height: 720, Refresh: 60}},
		{name: "pixel budget exceeded", value: "8192x8192", wantErr: true},
		{name: "zero dimension", value: "0x1080", wantErr: true},
		{name: "zero refresh", value: "1920x1080@0", wantErr: true},
		{name: "malformed", value: "1080p", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseMode(tt.value)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseMode(%q) error = %v, wantErr %t", tt.value, err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Fatalf("ParseMode(%q) = %#v, want %#v", tt.value, got, tt.want)
			}
		})
	}
}
