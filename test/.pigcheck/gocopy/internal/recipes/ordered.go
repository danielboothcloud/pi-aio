package recipes

import (
	"encoding/json"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// JavaScript object order for the scaffold copy (jsstr.DecodeObject).
func decodeObject(raw json.RawMessage) (jsstr.Object, bool) { return jsstr.DecodeObject(raw) }

func isJSONObject(raw json.RawMessage) bool { return jsstr.IsJSONObject(raw) }
