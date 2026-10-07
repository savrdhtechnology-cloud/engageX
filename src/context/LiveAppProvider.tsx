import React, { useState, useEffect, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AppContext, type AppContextType } from './AppContext';
import { supabase, workspaceSlug } from '../lib/supabase';
import { normalizePhone } from '../lib/metrics';
import type { Contact, Campaign, UserSession, WorkspaceBilling } from '../types';
import { personalizeMessage, renderCompanyMessage, resolveWorkspaceBranding, templateVariables } from '../lib/workspaceBranding';
import { deleteEngageXRecordFromMainCrm, reconcileEngageXMainCrm, syncEngageXRecord } from '../lib/mainCrmSync';

const signedOut: UserSession = { email: '', name: '', role: '', avatar: 'U', isAuthenticated: false };
const emptyBilling: WorkspaceBilling = { plan_code: 'unconfigured', plan_name: 'Not activated', status: 'pending', monthly_price: 0, message_credits: 0, contact_limit: 10000, monthly_message_limit: 0, whatsapp_usage: 0, sms_usage: 0, email_usage: 0 };
const tables = ['contacts','campaigns','messages','templates','automations','integrations','members','audit_logs','notifications'] as const;
const blank = (): Record<typeof tables[number], any[]> => ({ contacts:[],campaigns:[],messages:[],templates:[],automations:[],integrations:[],members:[],audit_logs:[],notifications:[] });
const unavailable = (feature: string): never => { throw new Error(`${feature} is not configured yet. No message, payment or external request was sent.`); };

export const LiveAppProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
  const [currentView, setCurrentView] = useState<AppContextType['currentView']>('landing');
  const [appTab, setAppTab] = useState('dashboard');
  const [activeChatContactId, setActiveChatContactId] = useState('');
  const [userSession, setUserSession] = useState(signedOut);
  const [workspace, setWorkspace] = useState<any>(null);
  const [records, setRecords] = useState(blank);
  const [billing, setBilling] = useState(emptyBilling);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const uid = useRef<string | null>(null);
  const workspaceId = useRef<string | null>(null);
  const reportError = (e: unknown) => setError(e instanceof Error ? e.message : String((e as any)?.message || e));

  const fetchRows = async (table: string, wid: string) => {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('engagex_' + table).select('*').eq('workspace_id',wid).order('id').range(offset, offset+999);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < 1000) return rows;
    }
  };

  const loadWorkspace = async (session: Session | null, navigate = false, slug = workspaceSlug) => {
    const ticket = ++generation.current;
    const nextUid = session?.user.id || null;
    if (uid.current !== nextUid) { workspaceId.current=null; setRecords(blank()); setWorkspace(null); setBilling(emptyBilling); setUserSession(signedOut); }
    uid.current = nextUid;
    if (!session) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data: w, error: wError } = await supabase.from('engagex_workspaces').select('*').eq('slug',slug).maybeSingle();
      if (wError) throw new Error(wError.message);
      if (!w) throw new Error('This account has no EngageX workspace access. Ask the workspace owner to add you.');
      const [entries, bill] = await Promise.all([
        Promise.all(tables.map(async t => [t, await fetchRows(t,w.id)] as const)),
        supabase.from('engagex_billing').select('*').eq('workspace_id',w.id).single(),
      ]);
      if (bill.error) throw new Error(bill.error.message);
      if (ticket !== generation.current) return;
      const nextRecords = Object.fromEntries(entries) as typeof records;
      const member = nextRecords.members.find(m => m.user_id === session.user.id && m.status === 'active');
      const role = w.owner_id === session.user.id ? 'Owner' : member?.role;
      if (!role) throw new Error('Your EngageX membership is not active.');
      workspaceId.current=w.id; setWorkspace(w); setRecords(nextRecords); setBilling(bill.data); setError('');
      setUserSession({ email: session.user.email || '', name: member?.name || session.user.email || 'User', role, avatar: member?.avatar || 'U', isAuthenticated: true });
      if (navigate) setCurrentView('app');
    } catch (e) {
      if(ticket === generation.current) { setUserSession(signedOut); setRecords(blank()); setWorkspace(null); reportError(e); setCurrentView('login'); }
      throw e;
    } finally { if (ticket === generation.current) setLoading(false); }
  };

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({data,error}) => { if (!active) return; if(error) {reportError(error);setLoading(false);} else void loadWorkspace(data.session, !!data.session).catch(() => {}); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Do not make awaited Supabase calls inside the auth callback lock.
      if (event === 'SIGNED_OUT') { generation.current++; uid.current=null; workspaceId.current=null; setRecords(blank()); setWorkspace(null); setBilling(emptyBilling); setUserSession(signedOut); setCurrentView('login'); setLoading(false); }
      else if (event === 'SIGNED_IN' && uid.current !== session?.user.id) setTimeout(() => { if (active) void loadWorkspace(session,true).catch(() => {}); },0);
    });
    return () => { active=false; generation.current++; subscription.unsubscribe(); };
  }, []);

  const requireWorkspace = () => { if (!workspace || !userSession.isAuthenticated) throw new Error('Please sign in to EngageX.'); return workspace.id as string; };
  const refresh = async (table: typeof tables[number]) => {
    const wid = requireWorkspace(), ticket = generation.current;
    const rows = await fetchRows(table,wid);
    if (ticket === generation.current && wid===workspaceId.current) setRecords(prev => ({...prev,[table]:rows}));
  };
  const refreshProfile = async () => {
    const wid=requireWorkspace(),ticket=generation.current;
    const {data,error}=await supabase.from('engagex_workspaces').select('*').eq('id',wid).single();
    if(error) throw new Error(error.message);
    if(ticket===generation.current&&wid===workspaceId.current) setWorkspace(data);
  };
  const run = async <T,>(action: () => Promise<T>): Promise<T> => { try {setError('');return await action();} catch(e) {reportError(e);throw e;} };
  const sendEmailViaServer = async (body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Please sign in to EngageX.');
    const response = await fetch('https://engagex-savrdh-technology.vercel.app/api/engagex-send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) throw new Error(data?.error || 'Email was not accepted by the provider.');
    return data;
  };
  const insert = async (table: typeof tables[number], values: any) => run(async () => {
    const {data,error} = await supabase.from('engagex_'+table).insert({...values,workspace_id:requireWorkspace()}).select().single();
    if(error) throw new Error(error.message);
    await refresh(table); await refresh('audit_logs'); return data;
  });
  const update = async (table: typeof tables[number], id: string, values: any) => run(async () => {
    const {data,error} = await supabase.from('engagex_'+table).update(values).eq('workspace_id',requireWorkspace()).eq('id',id).select('id');
    if(error) throw new Error(error.message); if(!data?.length) throw new Error('Record not found or access denied.');
    await refresh(table); await refresh('audit_logs');
  });
  const remove = async (table: typeof tables[number], ids: string[]) => run(async () => {
    const {data,error} = await supabase.from('engagex_'+table).delete().eq('workspace_id',requireWorkspace()).in('id',ids).select('id');
    if(error) throw new Error(error.message); if(data?.length !== ids.length) throw new Error('Some records were not deleted. They may no longer exist or you may lack permission.');
    await refresh(table); await refresh('audit_logs');
  });
  useEffect(() => {
    if (!workspace?.id || !userSession.isAuthenticated) return;
    const sync = () => { void refreshProfile().catch(reportError);for (const table of tables) void refresh(table).catch(reportError); };
    sync(); window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, [workspace?.id, appTab, userSession.isAuthenticated]);

  useEffect(() => {
    if (!workspace?.id || workspace?.slug !== 'savrdh-engagex' || !userSession.isAuthenticated) return;
    const target = { id: workspace.id, slug: workspace.slug, name: workspace.name };
    void reconcileEngageXMainCrm(target).catch(reportError);
  }, [workspace?.id, workspace?.slug, userSession.isAuthenticated]);

  const normalizeContact = (data: Omit<Contact,'id'|'created_at'>) => ({...data,name:data.name.trim(),email:data.email.trim().toLowerCase(),mobile:normalizePhone(data.mobile) ? '+'+normalizePhone(data.mobile) : ''});
  const safely = (action: () => Promise<unknown>) => { void action().catch(reportError); };

  const value: AppContextType = {
    live:true, currentView, setCurrentView, appTab, setAppTab, activeChatContactId, setActiveChatContactId,
    userSession, reportError, workspaceSettings:workspace?.settings || {}, activeWorkspace: workspace ? { id: workspace.id, slug: workspace.slug, name: workspace.name } : null,
    switchWorkspace: async (slug: string) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error('Please sign in to EngageX.');
      await loadWorkspace(data.session, false, slug);
      setActiveChatContactId('');
      setAppTab('dashboard');
      setCurrentView('app');
    },
    saveWorkspaceSettings: settings => run(async () => {
      const {data,error}=await supabase.from('engagex_workspaces').update({name:settings.workspaceName,settings}).eq('id',requireWorkspace()).select().single();
      if(error) throw new Error(error.message); setWorkspace(data); await refresh('audit_logs');
    }),
    login: async (email,password) => {
      if(!password) throw new Error('Enter your existing account password. Quick sign-in is disabled for the live database.');
      const {data,error} = await supabase.auth.signInWithPassword({email:email.trim(),password});
      if(error) throw new Error(error.message); await loadWorkspace(data.session,true);
    },
    logout: async () => { const {error}=await supabase.auth.signOut({scope:'local'}); if(error) reportError(error); },
    contacts:records.contacts, campaigns:records.campaigns, messages:records.messages, templates:records.templates,
    refreshContacts:()=>refresh('contacts'),
    automations:records.automations, integrations:records.integrations, team:records.members, billing, auditLogs:records.audit_logs,
    notifications:records.notifications, unreadNotificationsCount:records.notifications.filter(n=>!n.read).length,
    markNotificationRead:id=>safely(()=>update('notifications',id,{read:true})),
    markAllNotificationsRead:()=>safely(async()=>{await Promise.all(records.notifications.filter(n=>!n.read).map(n=>update('notifications',n.id,{read:true})));}),
    deleteNotification:id=>safely(()=>remove('notifications',[id])),
    addNotification:()=>{}, // Notifications are generated by trusted server events.
    addAuditLog:()=>{}, // Database triggers create immutable audit events.
    addContact:data=>run(async()=>{
      const wid=requireWorkspace();
      const {data:created,error}=await supabase.from('engagex_contacts').insert({...normalizeContact(data),workspace_id:wid}).select('*').single();
      if(error) throw new Error(error.message);
      await syncEngageXRecord(workspace ? {id:wid,slug:workspace.slug,name:workspace.name} : null,'contact',created);
      await refresh('contacts'); await refresh('audit_logs');
      return created;
    }),
    updateContact:(id,data)=>run(async()=>{
      const wid=requireWorkspace();
      const { id: _id, workspace_id: _wid, created_at: _created, ...contact } = {...records.contacts.find(c=>c.id===id),...data};
      const {data:updated,error}=await supabase.from('engagex_contacts').update(normalizeContact(contact)).eq('workspace_id',wid).eq('id',id).select('*').single();
      if(error) throw new Error(error.message);
      await syncEngageXRecord(workspace ? {id:wid,slug:workspace.slug,name:workspace.name} : null,'contact',updated);
      await refresh('contacts'); await refresh('audit_logs');
    }),
    deleteContact:id=>safely(()=>run(async()=>{
      const wid=requireWorkspace();
      const {error}=await supabase.from('engagex_contacts').delete().eq('workspace_id',wid).eq('id',id);
      if(error) throw new Error(error.message);
      await deleteEngageXRecordFromMainCrm(workspace ? {id:wid,slug:workspace.slug,name:workspace.name} : null,'contact',id);
      await refresh('contacts'); await refresh('audit_logs');
    })),
    bulkDeleteContacts:ids=>run(async()=>{
      const wid=requireWorkspace();
      const {data:deleted,error}=await supabase.from('engagex_contacts').delete().eq('workspace_id',wid).in('id',ids).select('id');
      if(error) throw new Error(error.message);
      for(const row of deleted||[]) await deleteEngageXRecordFromMainCrm(workspace ? {id:wid,slug:workspace.slug,name:workspace.name} : null,'contact',row.id);
      await refresh('contacts'); await refresh('audit_logs');
    }),
    importContacts:items=>run(async()=>{
      requireWorkspace(); let inserted=0, duplicates=0;
      for(const item of items) {
        const {data:created,error}=await supabase.from('engagex_contacts').insert({...normalizeContact(item),workspace_id:workspace.id}).select('*').single();
        if(error?.code==='23505') duplicates++;
        else if(error) { await refresh('contacts'); throw new Error(`${inserted} imported before failure: ${error.message}`); }
        else {
          inserted++;
          await syncEngageXRecord({id:workspace.id,slug:workspace.slug,name:workspace.name},'contact',created);
        }
      }
      await refresh('contacts');await refresh('audit_logs');return {inserted,duplicates};
    }),
    addCampaign:data=>insert('campaigns',{...data,status:'draft',send_mode:'draft',scheduled_at:null}),
    updateCampaign:(id,data)=>update('campaigns',id,data),
    deleteCampaign:id=>safely(()=>remove('campaigns',[id])),
    queueCampaign:id=>run(async()=>{
      const campaign=records.campaigns.find(c=>c.id===id);
      if(!campaign) throw new Error('Campaign not found.');
      if(!Array.isArray(campaign.channels) || campaign.channels.length!==1 || campaign.channels[0]!=='email')
        throw new Error('Live queue is currently available for Email campaigns only.');

      let ids:string[]|null=null;
      if(typeof campaign.target_audience==='string' && campaign.target_audience.startsWith('Contacts: ')) {
        try { const parsed=JSON.parse(campaign.target_audience.slice(10)); if(Array.isArray(parsed)) ids=parsed.filter((x:any)=>typeof x==='string'); } catch {}
      }

      let audience=records.contacts.filter(c=>c.status==='active' && c.email_consent && !!c.email);
      if(ids) audience=audience.filter(c=>ids!.includes(c.id));
      if(!audience.length) throw new Error('No eligible contacts with recorded email consent were found for this campaign.');

      await update('campaigns',id,{status:'running',sent_count:0,delivered_count:0,failed_count:0});
      let sent=0,failed=0;

      for(const contact of audience) {
        try {
          const brand=resolveWorkspaceBranding(workspace,workspace.settings);
          const subject=personalizeMessage(campaign.subject||('Message from '+brand.companyName),contact,brand);
          const body=renderCompanyMessage(campaign.body||'',contact,brand);
          const missing=templateVariables(subject+'\n'+body);
          if(missing.length) throw new Error('Missing template values: '+missing.join(', '));
          const requestId=crypto.randomUUID();
          await sendEmailViaServer({
            workspace_id: requireWorkspace(),
            contact_id: contact.id,
            subject,
            text: body,
            request_id: requestId,
            campaign_id: id,
          });
          sent++;
        } catch {
          failed++;
        }
        await supabase.from('engagex_campaigns').update({sent_count:sent,failed_count:failed}).eq('workspace_id',requireWorkspace()).eq('id',id);
      }

      await supabase.from('engagex_campaigns').update({status:'completed',sent_count:sent,failed_count:failed}).eq('workspace_id',requireWorkspace()).eq('id',id);
      await refresh('campaigns'); await refresh('messages'); await refresh('audit_logs');
      if(!sent) throw new Error('No campaign emails were accepted by Resend.');
    }),
    simulateCampaignRun:()=>reportError(new Error('Simulations are disabled for the live database.')),
    sendMessage:payload=>run(async()=>{
      if(payload.channel!=='email') unavailable('SMS / WhatsApp API provider');
      const wid=requireWorkspace(),contact=records.contacts.find(c=>c.id===payload.contact_id);
      if(!contact) throw new Error('Select a saved contact in this workspace.');
      const brand=resolveWorkspaceBranding(workspace,workspace.settings);
      const subject=personalizeMessage(payload.subject||'Message from '+brand.companyName,contact,brand),text=renderCompanyMessage(payload.body,contact,brand);
      const missing=templateVariables(subject+'\n'+text);
      if(missing.length) throw new Error('Fill these message values before sending: '+missing.join(', ')+'.');
      await sendEmailViaServer({
        workspace_id: wid,
        contact_id: payload.contact_id,
        subject,
        text,
        request_id: payload.request_id || crypto.randomUUID(),
        campaign_id: payload.campaign_id || null,
      });
      await refresh('messages'); await refresh('audit_logs');
    }),
    simulateCustomerReply:()=>reportError(new Error('Live replies must arrive through a verified provider webhook.')),
    addTemplate:async data=>{await insert('templates',{...data,status:'draft'});},
    updateTemplate:(id,data)=>update('templates',id,data),
    deleteTemplate:id=>safely(()=>remove('templates',[id])),
    addAutomation:async data=>{await insert('automations',{...data,status:'paused'});},
    toggleAutomation:()=>reportError(new Error('Automation activation requires a configured provider and durable worker. Workflow drafts are saved in the database.')),
    testAutomation:async()=>['Provider execution is not configured. No workflow was run and no messages were sent.'],
    updateIntegration:(id,config)=>update('integrations',id,{config:Object.fromEntries(Object.entries(config).filter(([key])=>!/secret|token|password|api.?key|auth.?key/i.test(key)))}),
    testIntegration:async provider=>({success:false,message:`${provider}: server-side credentials are not configured.`,latency_ms:0}),
    inviteTeamMember:async(email,role,name)=>{await insert('members',{email:email.trim().toLowerCase(),role,name:name||email.split('@')[0],avatar:email[0].toUpperCase(),status:'invited'});},
    removeTeamMember:id=>safely(()=>remove('members',[id])),
    addCredits:()=>reportError(new Error('Payment gateway is not configured. No credits have been added.')),
    changePlan:()=>reportError(new Error('Subscription checkout is not configured. Your plan has not changed.')),
    resetToDefaults:()=>reportError(new Error('Demo reset is disabled for the live database.')),
  };
  return <AppContext.Provider value={value}>
    {error && <div className="notice errorNotice" role="alert" style={{position:'fixed',bottom:16,right:16,zIndex:9999,maxWidth:480}}>{error}<button type="button" onClick={()=>setError('')} aria-label="Dismiss error">×</button></div>}
    {loading && currentView==='app' ? <div className="notice" role="status">Loading EngageX workspace…</div> : children}
  </AppContext.Provider>;
};
