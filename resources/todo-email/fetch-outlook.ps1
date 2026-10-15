# AionUi todo email source adapter (v1: desktop Outlook via COM).
# Exports recent inbox mail to a JSON snapshot consumed by the todo MCP's
# email_snapshot_read tool. ALWAYS exits 0 and writes a snapshot file - the
# error field carries any failure reason (Outlook missing, profile locked...),
# so the host degrades gracefully instead of treating "no email" as a crash.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File fetch-outlook.ps1 -OutFile <path> [-Days 3]

param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$Days = 3,
    [int]$MaxEmails = 100
)

$ErrorActionPreference = 'Stop'

function Write-Snapshot([string]$errorMessage, [array]$emails) {
    $snapshot = @{
        fetched_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        source     = 'outlook-com'
        emails     = @($emails)
    }
    if ($errorMessage) { $snapshot.error = $errorMessage }
    $json = ConvertTo-Json -InputObject $snapshot -Depth 5
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json)
}

try {
    $outlook = New-Object -ComObject Outlook.Application
    $inbox = $outlook.Session.GetDefaultFolder(6) # olFolderInbox
    $items = $inbox.Items
    $items.Sort("[ReceivedTime]", $true) # newest first

    $sinceLocal = (Get-Date).AddDays(-$Days)
    $emails = New-Object System.Collections.ArrayList

    foreach ($item in $items) {
        try {
            if ($item.Class -ne 43) { continue } # 43 = olMail

            $received = $item.ReceivedTime
            if ($received -lt $sinceLocal) { break } # sorted desc -> nothing older remains

            # 邮件头 Message-ID:proptag 写法在中文版 Outlook 上可靠;schemas URN
            # 在部分版本会报"属性未知";EntryID 仅作最后兜底(邮件移动文件夹后会变)。
            # Internet Message-ID: the MAPI proptag form works on zh-CN Outlook
            # builds where the schemas URN is rejected; EntryID is the last
            # resort (it changes when the item moves between folders).
            $messageId = ''
            try { $messageId = [string]$item.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x1035001F") } catch {}
            if (-not $messageId) { try { $messageId = [string]$item.PropertyAccessor.GetProperty("urn:schemas:mailheader:message-id") } catch {} }
            if (-not $messageId) { $messageId = "outlook-entryid:" + [string]$item.EntryID }

            $subject = ''
            try { $subject = [string]$item.Subject } catch {}
            $senderName = ''
            try { $senderName = [string]$item.SenderName } catch {}
            $body = ''
            try {
                if ($item.Body) { $body = [string]$item.Body }
            } catch {}
            if ($body.Length -gt 1500) { $body = $body.Substring(0, 1500) }
            # Strip control chars that break JSON round-trips.
            $body = $body -replace "[\x00-\x08\x0B\x0C\x0E-\x1F]", " "

            $receivedMs = [DateTimeOffset]::new($received).ToUnixTimeMilliseconds()
            $unread = $false
            try { $unread = [bool]$item.UnRead } catch {}
            $senderAddress = ''
            try { $senderAddress = [string]$item.SenderEmailAddress } catch {}

            [void]$emails.Add([ordered]@{
                message_id    = $messageId
                subject       = $subject
                from_name     = $senderName
                from_address  = $senderAddress
                received_at   = $receivedMs
                folder        = 'Inbox'
                body_preview  = $body
                unread        = $unread
            })

            if ($emails.Count -ge $MaxEmails) { break }
        } catch { continue } # one poisoned item must not abort the export
    }

    Write-Snapshot $null $emails
    Write-Output ("OK " + $emails.Count)
} catch {
    Write-Snapshot ("outlook unavailable: " + $_.Exception.Message) @()
    Write-Output ("ERR " + $_.Exception.Message)
}
