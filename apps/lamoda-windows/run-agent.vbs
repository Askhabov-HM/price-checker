If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = WScript.Arguments(2)
command = Chr(34) & WScript.Arguments(0) & Chr(34) & " " & Chr(34) & WScript.Arguments(1) & Chr(34)
WScript.Quit shell.Run(command, 0, True)
