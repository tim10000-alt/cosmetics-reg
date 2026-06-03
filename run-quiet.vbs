' cosmetics-reg — CMD 창 없이 실행 (조용히 시작 + 브라우저 자동 오픈)
'
' 더블클릭하면 검은 CMD 창 없이 백그라운드에서 서버가 뜨고 브라우저만 열립니다.
' 단, 첫 실행(다운로드/빌드 필요)일 때만 진행상황 확인용으로 창을 잠깐 보여주고,
' 설치가 끝난 뒤부터는 창을 완전히 숨깁니다.
'
' 종료하려면 같은 폴더의 stop.bat 더블클릭 (서버를 깔끔히 종료).
Option Explicit
Dim fso, sh, base, style
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

' 이미 설치+빌드 완료면 창 숨김(0), 첫 실행이면 진행 표시(1)
If fso.FileExists(base & "\out\index.html") And fso.FolderExists(base & "\node_modules") Then
  style = 0
Else
  style = 1
End If

' start.bat 를 해당 window style 로 실행 (False = 끝까지 안 기다리고 즉시 반환)
sh.Run "cmd /c """ & base & "\start.bat""", style, False
