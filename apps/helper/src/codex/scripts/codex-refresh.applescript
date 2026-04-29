-- Opens Codex.app to the target thread. When the refresh mode is "mini-window",
-- it opens Codex's mini window briefly because that forces Codex.app to reload
-- the visible thread more reliably than bouncing through settings.
-- Args: bundleId, appPath, optional targetUrl (codex://threads/<uuid>),
-- optional refreshModeOrPreflightUrl, optional miniWindowOpenMs.

on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set targetUrl to ""
  set refreshModeOrPreflightUrl to ""
  set miniWindowOpenSeconds to 2.5

  if (count of argv) is greater than or equal to 3 then
    set targetUrl to item 3 of argv
  end if
  if (count of argv) is greater than or equal to 4 then
    set refreshModeOrPreflightUrl to item 4 of argv
  end if
  if (count of argv) is greater than or equal to 5 then
    try
      set miniWindowOpenSeconds to ((item 5 of argv) as number) / 1000
    end try
  end if

  if refreshModeOrPreflightUrl is "mini-window" and targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, targetUrl)
    my openMiniWindowBriefly(bundleId, miniWindowOpenSeconds)
  else if refreshModeOrPreflightUrl is not "" and targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, refreshModeOrPreflightUrl)
    delay 0.18
    my openCodexUrl(bundleId, appPath, targetUrl)
  else if targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, targetUrl)
  else
    my openCodexUrl(bundleId, appPath, "")
  end if

  delay 0.12
  try
    tell application id bundleId to activate
  end try
end run

on openCodexUrl(bundleId, appPath, targetUrl)
  try
    if targetUrl is not "" then
      do shell script "open -b " & quoted form of bundleId & " " & quoted form of targetUrl
    else
      do shell script "open -b " & quoted form of bundleId
    end if
  on error
    if targetUrl is not "" then
      do shell script "open -a " & quoted form of appPath & " " & quoted form of targetUrl
    else
      do shell script "open -a " & quoted form of appPath
    end if
  end try
end openCodexUrl

on openMiniWindowBriefly(bundleId, openSeconds)
  delay 0.65
  try
    tell application id bundleId to activate
  end try
  delay 0.15

  set beforeWindowSignatures to my codexWindowSignatures(bundleId)

  tell application "System Events"
    set codexProcess to first process whose bundle identifier is bundleId
    set frontmost of codexProcess to true
    tell codexProcess
      keystroke "p" using {command down, shift down}
      delay 0.2
      keystroke "a" using {command down}
      delay 0.03
      keystroke "open in mini window"
      delay 0.3
      key code 36
    end tell
  end tell

  set openedMiniWindow to my waitForNewMiniCodexWindow(bundleId, beforeWindowSignatures, 4.0)
  if openedMiniWindow then
    delay openSeconds
    my closeNewMiniCodexWindow(bundleId, beforeWindowSignatures)
  end if
end openMiniWindowBriefly

on waitForNewMiniCodexWindow(bundleId, beforeWindowSignatures, timeoutSeconds)
  set waitedSeconds to 0
  repeat while waitedSeconds < timeoutSeconds
    delay 0.1
    set waitedSeconds to waitedSeconds + 0.1
    if my hasNewMiniCodexWindow(bundleId, beforeWindowSignatures) then
      return true
    end if
  end repeat
  return false
end waitForNewMiniCodexWindow

on hasNewMiniCodexWindow(bundleId, beforeWindowSignatures)
  tell application "System Events"
    set codexProcess to first process whose bundle identifier is bundleId
    tell codexProcess
      repeat with candidateWindow in windows
        if my isNewMiniCodexWindow(candidateWindow, beforeWindowSignatures) then
          return true
        end if
      end repeat
    end tell
  end tell
  return false
end hasNewMiniCodexWindow

on closeNewMiniCodexWindow(bundleId, beforeWindowSignatures)
  tell application "System Events"
    set codexProcess to first process whose bundle identifier is bundleId
    tell codexProcess
      repeat with windowIndex from (count of windows) to 1 by -1
        try
          set candidateWindow to window windowIndex
          if my isNewMiniCodexWindow(candidateWindow, beforeWindowSignatures) then
            click button 1 of candidateWindow
            return
          end if
        end try
      end repeat
    end tell
  end tell
end closeNewMiniCodexWindow

on isNewMiniCodexWindow(candidateWindow, beforeWindowSignatures)
  set candidateSignature to my codexWindowSignature(candidateWindow)
  if my listContains(beforeWindowSignatures, candidateSignature) then
    return false
  end if
  return my isMiniCodexWindow(candidateWindow)
end isNewMiniCodexWindow

on isMiniCodexWindow(candidateWindow)
  tell application "System Events"
    set actualWindow to contents of candidateWindow
    set windowSize to size of actualWindow
    set windowWidth to item 1 of windowSize
    set windowHeight to item 2 of windowSize
  end tell

  -- The mini window is a compact popout. The main Codex window can be reordered
  -- by macOS, so never close by window index alone.
  return windowWidth is greater than or equal to 320 and windowWidth is less than or equal to 1000 and windowHeight is greater than or equal to 320 and windowHeight is less than or equal to 1000
end isMiniCodexWindow

on codexWindowSignatures(bundleId)
  set windowSignatures to {}
  tell application "System Events"
    set codexProcess to first process whose bundle identifier is bundleId
    tell codexProcess
      repeat with candidateWindow in windows
        set end of windowSignatures to my codexWindowSignature(candidateWindow)
      end repeat
    end tell
  end tell
  return windowSignatures
end codexWindowSignatures

on codexWindowSignature(candidateWindow)
  tell application "System Events"
    set actualWindow to contents of candidateWindow
    set windowName to name of actualWindow
    set windowPosition to position of actualWindow
    set windowSize to size of actualWindow
  end tell
  return windowName & "|" & ((item 1 of windowPosition) as text) & "," & ((item 2 of windowPosition) as text) & "|" & ((item 1 of windowSize) as text) & "x" & ((item 2 of windowSize) as text)
end codexWindowSignature

on listContains(candidateList, candidateValue)
  repeat with existingValue in candidateList
    if (existingValue as text) is candidateValue then
      return true
    end if
  end repeat
  return false
end listContains

on codexWindowCount(bundleId)
  tell application "System Events"
    set codexProcess to first process whose bundle identifier is bundleId
    return count of windows of codexProcess
  end tell
end codexWindowCount
