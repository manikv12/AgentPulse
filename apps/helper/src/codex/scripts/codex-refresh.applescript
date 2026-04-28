-- Opens Codex.app to the target thread without bouncing through Codex settings.
-- Args: bundleId, appPath, optional targetUrl (codex://threads/<uuid>).

on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set targetUrl to ""

  if (count of argv) is greater than or equal to 3 then
    set targetUrl to item 3 of argv
  end if

  if targetUrl is not "" then
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
