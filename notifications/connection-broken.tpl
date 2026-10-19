<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:#ffffff;border-radius:6px;">
            <tr>
              <td style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#1f2933;">
                <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">{{ store.name }}</p>
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#1f2933;">Google Merchant Center is disconnected</h1>
                <p style="margin:0 0 8px;">Google reported this problem with the connection:</p>
                <p style="margin:0 0 16px;padding:12px 16px;background-color:#fef3f2;border-radius:4px;color:#7a271a;">{{ last_error }}</p>
                <p style="margin:0 0 24px;">Products are not being sent to Google until it is fixed.</p>
                <p style="margin:0 0 24px;">
                  <a href="{{ store.url }}/admin/apps" style="display:inline-block;padding:10px 18px;background-color:#1f2933;color:#ffffff;text-decoration:none;border-radius:4px;">Open your apps</a>
                </p>
                <p style="margin:0;font-size:13px;color:#6b7280;">Open Google Merchant Center in your Swell dashboard under Apps and reconnect it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
