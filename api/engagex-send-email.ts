export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', 'https://savrdhtechnologies.com');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.ENGAGEX_FROM_EMAIL || 'info@savrdhtechnologies.com';
    const fromName = process.env.ENGAGEX_FROM_NAME || 'Savrdh Technology';

    if (!supabaseUrl || !publishableKey || !resendKey) {
      res.status(503).json({ error: 'Email provider is not fully configured.' });
      return;
    }

    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Please sign in to EngageX.' });
      return;
    }

    const userResp = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: authorization, apikey: publishableKey },
    });
    if (!userResp.ok) {
      res.status(401).json({ error: 'Your EngageX session has expired.' });
      return;
    }
    const user = await userResp.json();

    const body = req.body || {};
    const workspaceId = String(body.workspace_id || '');
    const contactId = String(body.contact_id || '');
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '').trim();
    const requestId = String(body.request_id || crypto.randomUUID());

    if (!workspaceId || !contactId || !subject || !text) {
      res.status(400).json({ error: 'Select a workspace/contact and enter an email subject and message.' });
      return;
    }

    const authHeaders = {
      Authorization: authorization,
      apikey: publishableKey,
      Accept: 'application/json',
    };

    const [workspaceResp, memberResp, contactResp] = await Promise.all([
      fetch(
        supabaseUrl + '/rest/v1/engagex_workspaces?id=eq.' + encodeURIComponent(workspaceId) + '&select=id,owner_id,slug',
        { headers: authHeaders },
      ),
      fetch(
        supabaseUrl + '/rest/v1/engagex_members?workspace_id=eq.' + encodeURIComponent(workspaceId) +
        '&user_id=eq.' + encodeURIComponent(user.id) + '&status=eq.active&select=role,status',
        { headers: authHeaders },
      ),
      fetch(
        supabaseUrl + '/rest/v1/engagex_contacts?workspace_id=eq.' + encodeURIComponent(workspaceId) +
        '&id=eq.' + encodeURIComponent(contactId) + '&select=*',
        { headers: authHeaders },
      ),
    ]);

    if (!workspaceResp.ok || !memberResp.ok || !contactResp.ok) {
      res.status(403).json({ error: 'Unable to verify workspace access.' });
      return;
    }

    const workspaces = await workspaceResp.json();
    const members = await memberResp.json();
    const contacts = await contactResp.json();
    const workspace = workspaces?.[0];
    const member = members?.[0];
    const contact = contacts?.[0];

    const role = workspace?.owner_id === user.id ? 'Owner' : member?.role;
    if (!['Owner', 'Admin', 'Manager'].includes(role)) {
      res.status(403).json({ error: 'Owner, Admin or Manager workspace access is required.' });
      return;
    }

    if (!contact) {
      res.status(404).json({ error: 'Contact not found in this workspace.' });
      return;
    }

    if (contact.status !== 'active' || !contact.email_consent || !contact.email) {
      res.status(409).json({ error: 'This contact needs an active email address and recorded email consent.' });
      return;
    }

    if (workspace?.slug !== 'savrdh-engagex') {
      res.status(403).json({ error: 'This sender is configured for the Savrdh Technology workspace only.' });
      return;
    }

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resendKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'engagex-' + workspaceId + '-' + requestId,
      },
      body: JSON.stringify({
        from: fromName + ' <' + fromEmail + '>',
        to: [contact.email],
        reply_to: fromEmail,
        subject,
        text,
      }),
    });

    const resendData = await resendResp.json().catch(() => ({}));
    if (!resendResp.ok || !resendData?.id) {
      res.status(resendResp.status || 502).json({ error: resendData?.message || 'Email was not accepted by Resend.' });
      return;
    }

    try {
      await fetch(supabaseUrl + '/rest/v1/engagex_messages', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          id: requestId,
          workspace_id: workspaceId,
          contact_id: contact.id,
          contact_name: contact.name,
          contact_email: contact.email,
          contact_phone: contact.mobile,
          channel: 'email',
          direction: 'outbound',
          status: 'sent',
          subject,
          body: text,
          provider_message_id: resendData.id,
          campaign_id: body.campaign_id || null,
        }),
      });
    } catch {}

    res.status(200).json({ ok: true, id: resendData.id, contact_id: contact.id });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Unable to send the email.' });
  }
}
