# AionUi todo email source adapter (v1: desktop Outlook via COM).
# Exports recent inbox mail to a JSON snapshot consumed by the todo MCP's
# email_snapshot_read tool. ALWAYS exits 0 and writes a snapshot file - the
# error field carries any failure reason (Outlook missing, profile locked...),
# so the host degrades gracefully instead of treating "no email" as a crash.
#
# Besides the mail itself the snapshot records who the mailbox owner is and
# who each mail was addressed to, so the scan can tell the user's own asks
# from mail about other people's work.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File fetch-outlook.ps1 -OutFile <path> [-Days 3]

param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$Days = 3,
    [int]$MaxEmails = 100
)

$ErrorActionPreference = 'Stop'

$PR_SMTP_ADDRESS = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001F'
$PR_TRANSPORT_MESSAGE_HEADERS = 'http://schemas.microsoft.com/mapi/proptag/0x007D001F'
$MaxRecipients = 40
$MaxBodyChars = 6000

function Write-Snapshot([string]$errorMessage, [array]$emails, $mailbox) {
    $snapshot = @{
        fetched_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        source     = 'outlook-com'
        emails     = @($emails)
    }
    if ($mailbox) { $snapshot.mailbox = $mailbox }
    if ($errorMessage) { $snapshot.error = $errorMessage }
    $json = ConvertTo-Json -InputObject $snapshot -Depth 6
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # The host and the todo MCP can both refresh the snapshot: replace it
    # atomically so a reader never sees a half-written file.
    $tmp = "$OutFile.$PID.tmp"
    try {
        [System.IO.File]::WriteAllText($tmp, $json)
        # [NullString]: PowerShell would pass $null as "" (an invalid backup path).
        if ([System.IO.File]::Exists($OutFile)) { [System.IO.File]::Replace($tmp, $OutFile, [NullString]::Value) }
        else { [System.IO.File]::Move($tmp, $OutFile) }
    } finally {
        if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# Exchange recipients carry an X500 address (/o=...); PR_SMTP_ADDRESS holds the SMTP form.
function Get-SmtpAddress($recipient) {
    $address = ''
    try { $address = [string]$recipient.Address } catch {}
    if ($address -match '@' -and $address -notmatch '^/o=') { return $address }
    try {
        $smtp = [string]$recipient.PropertyAccessor.GetProperty($PR_SMTP_ADDRESS)
        if ($smtp) { return $smtp }
    } catch {}
    return $address
}

# $type: 1 = To, 2 = CC (OlMailRecipientType). Large distribution lists are capped.
function Get-Recipients($item, [int]$type) {
    $list = New-Object System.Collections.ArrayList
    try {
        foreach ($recipient in $item.Recipients) {
            if ($list.Count -ge $MaxRecipients) { break }
            try {
                if ($recipient.Type -ne $type) { continue }
                [void]$list.Add([ordered]@{ name = [string]$recipient.Name; address = (Get-SmtpAddress $recipient) })
            } catch {}
        }
    } catch {}
    return , $list.ToArray()
}

function Add-Unique($list, $value) {
    $text = ([string]$value).Trim()
    if ($text -and -not $list.Contains($text)) { [void]$list.Add($text) }
}

# The mailbox owner: every display name and address the user can be addressed by.
function Get-Mailbox($session) {
    $names = New-Object System.Collections.ArrayList
    $addresses = New-Object System.Collections.ArrayList
    try {
        $me = $session.CurrentUser
        Add-Unique $names $me.Name
        Add-Unique $addresses $me.Address
        Add-Unique $addresses (Get-SmtpAddress $me)
        try {
            $exchangeUser = $me.AddressEntry.GetExchangeUser()
            if ($exchangeUser) {
                Add-Unique $names $exchangeUser.Name
                Add-Unique $addresses $exchangeUser.PrimarySmtpAddress
            }
        } catch {}
    } catch {}
    try {
        foreach ($account in $session.Accounts) {
            try { Add-Unique $addresses $account.SmtpAddress } catch {}
        }
    } catch {}
    return [ordered]@{ names = $names.ToArray(); addresses = $addresses.ToArray() }
}

# Header lines that mark mailing-list or machine-sent mail.
function Get-ListHeaders($item) {
    try {
        $headers = [string]$item.PropertyAccessor.GetProperty($PR_TRANSPORT_MESSAGE_HEADERS)
        if (-not $headers) { return , @() }
        $lines = [regex]::Matches($headers, '(?im)^(List-Id|List-Unsubscribe|Auto-Submitted|Precedence)[ \t]*:[^\r\n]*') |
            Select-Object -First 6 |
            ForEach-Object { if ($_.Value.Length -gt 120) { $_.Value.Substring(0, 120) } else { $_.Value } }
        return , @($lines)
    } catch { return , @() }
}

try {
    $outlook = New-Object -ComObject Outlook.Application
    $session = $outlook.Session
    $mailbox = Get-Mailbox $session
    $inbox = $session.GetDefaultFolder(6) # olFolderInbox
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
            if ($body.Length -gt $MaxBodyChars) { $body = $body.Substring(0, $MaxBodyChars) }
            # Strip control chars that break JSON round-trips.
            $body = $body -replace "[\x00-\x08\x0B\x0C\x0E-\x1F]", " "

            $receivedMs = [DateTimeOffset]::new($received).ToUnixTimeMilliseconds()
            $unread = $false
            try { $unread = [bool]$item.UnRead } catch {}
            $senderAddress = ''
            try {
                $senderAddress = [string]$item.SenderEmailAddress
                if ($senderAddress -match '^/o=') { $senderAddress = Get-SmtpAddress $item.Sender }
            } catch {}
            $threadId = ''
            try { $threadId = [string]$item.ConversationID } catch {}
            $importance = ''
            try {
                if ($item.Importance -eq 2) { $importance = 'high' } elseif ($item.Importance -eq 0) { $importance = 'low' }
            } catch {}
            $flagged = $false
            try { $flagged = [bool]$item.IsMarkedAsTask -or ($item.FlagStatus -eq 2) } catch {}

            [void]$emails.Add([ordered]@{
                message_id    = $messageId
                subject       = $subject
                from_name     = $senderName
                from_address  = $senderAddress
                received_at   = $receivedMs
                folder        = 'Inbox'
                to            = (Get-Recipients $item 1)
                cc            = (Get-Recipients $item 2)
                thread_id     = $threadId
                importance    = $importance
                flagged       = $flagged
                list_headers  = (Get-ListHeaders $item)
                body_preview  = $body
                unread        = $unread
            })

            if ($emails.Count -ge $MaxEmails) { break }
        } catch { continue } # one poisoned item must not abort the export
    }

    Write-Snapshot $null $emails $mailbox
    Write-Output ("OK " + $emails.Count)
} catch {
    Write-Snapshot ("outlook unavailable: " + $_.Exception.Message) @() $null
    Write-Output ("ERR " + $_.Exception.Message)
}
