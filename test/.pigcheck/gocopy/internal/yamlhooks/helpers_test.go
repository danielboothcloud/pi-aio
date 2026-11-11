package yamlhooks

import "os"

var (
	osUnsetenv = os.Unsetenv
	osReadFile = os.ReadFile
)
