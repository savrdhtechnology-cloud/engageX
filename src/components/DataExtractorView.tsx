import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Check, Download, MapPin, MessageCircle, Plus, Search, Trash2, UserPlus } from 'lucide-react';
import { CommercialShell } from './CommercialShell';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useApp } from '../context/AppContext';
import { contactPhone, contactEmail, planProspectImport, prospectToContact } from '../lib/contactDirectory';
import { deleteEngageXRecordFromMainCrm, syncEngageXRecord } from '../lib/mainCrmSync';

type SearchHistory = {
  id: string;
  workspace_id: string;
  search_term: string | null;
  category: string | null;
  area: string | null;
  city: string | null;
  source: string;
  results_count: number;
  saved_count: number;
  created_at: string;
};

type Prospect = {
  id: string;
  workspace_id: string;
  source: 'google_maps' | 'web_search' | 'indiamart' | 'justdial' | 'csv' | 'manual';
  business_name: string;
  category: string | null;
  location: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  rating: number | null;
  source_url: string | null;
  business_type?: string | null;
  match_score?: number | null;
  lead_score?: number | null;
  recommended_product?: string | null;
  source_domain?: string | null;
  enrichment_status?: string | null;
  status: 'new' | 'reviewed' | 'contacted' | 'qualified' | 'converted' | 'do_not_contact';
  outreach_eligibility: 'review_required' | 'allowed' | 'do_not_contact';
  notes: string | null;
  created_at: string;
};

const sourceLabel: Record<Prospect['source'], string> = {
  google_maps: 'Google Maps',
  web_search: 'Web Intelligence',
  indiamart: 'IndiaMART',
  justdial: 'Justdial',
  csv: 'CSV Import',
  manual: 'Manual'
};

export const DataExtractorView: React.FC = () => {
  const { activeWorkspace, contacts, addContact, importContacts } = useApp();
  const [rows, setRows] = useState<Prospect[]>([]);
  const [history, setHistory] = useState<SearchHistory[]>([]);
  const [lastHistoryId, setLastHistoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | Prospect['source']>('all');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState('');
  const [area, setArea] = useState('');
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [liveResults, setLiveResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedLive, setSelectedLive] = useState<Record<string, boolean>>({});
  const [addedCrmKeys, setAddedCrmKeys] = useState<Set<string>>(new Set());
  const [resultView, setResultView] = useState<'list' | 'grid'>('list');
  const [form, setForm] = useState({
    source: 'manual' as Prospect['source'],
    business_name: '',
    category: '',
    location: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    source_url: '',
    notes: ''
  });

  const load = async () => {
    if (!activeWorkspace?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('engagex_prospects')
      .select('*')
      .eq('workspace_id', activeWorkspace.id)
      .order('created_at', { ascending: false });
    if (error) setNotice(error.message);
    setRows((data || []) as Prospect[]);
    setLoading(false);
  };

  const loadHistory = async () => {
    if (!activeWorkspace?.id) return;
    const { data, error } = await supabase
      .from('engagex_lead_search_history')
      .select('*')
      .eq('workspace_id', activeWorkspace.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) setNotice(error.message);
    setHistory((data || []) as SearchHistory[]);
  };

  useEffect(() => { void load(); void loadHistory(); }, [activeWorkspace?.id]);

  const runLiveSearch = async () => {
    if (!category.trim() && !query.trim() && !location.trim() && !area.trim()) {
      setNotice('Enter a business/category, area or city first.');
      return;
    }
    setSearching(true);
    setNotice('');
    setLiveResults([]);
    setSelectedLive({});
    setNextPageToken(null);
    setLastHistoryId(null);
    try {
      const { data, error } = await supabase.functions.invoke('engagex-lead-search', {
        body: {
          query: query.trim(),
          category: category.trim(),
          area: area.trim(),
          city: location.trim(),
          limit: 20
        }
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const results = data?.results || [];
      setLiveResults(results);
      setNextPageToken(data?.nextPageToken || null);

      const historyInsert = await supabase
        .from('engagex_lead_search_history')
        .insert({
          workspace_id: activeWorkspace?.id,
          search_term: query.trim() || null,
          category: category.trim() || null,
          area: area.trim() || null,
          city: location.trim() || null,
          source: 'google_maps',
          results_count: results.length,
          saved_count: 0
        })
        .select('id')
        .single();
      if (!historyInsert.error && historyInsert.data?.id) {
        setLastHistoryId(historyInsert.data.id);
        void loadHistory();
      }

      if (!results.length) setNotice('No Google Maps businesses found for this area/search.');
      else setNotice('Google Maps/Places results loaded for the selected area. Select the businesses you want to save.');
    } catch (e: any) {
      setNotice(e?.message || 'Live search failed.');
    } finally {
      setSearching(false);
    }
  };


  const loadMoreResults = async () => {
    if (!nextPageToken || searching) return;
    setSearching(true);
    setNotice('');
    try {
      const { data, error } = await supabase.functions.invoke('engagex-lead-search', {
        body: {
          query: query.trim(),
          category: category.trim(),
          area: area.trim(),
          city: location.trim(),
          limit: 20,
          pageToken: nextPageToken
        }
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      let mergedCount = 0;
      setLiveResults(prev => {
        const seen = new Set(prev.map((r:any) => r.external_id));
        const merged = [...prev, ...(data?.results || []).filter((r:any) => !seen.has(r.external_id))];
        mergedCount = merged.length;
        return merged;
      });
      setNextPageToken(data?.nextPageToken || null);
      if (lastHistoryId) {
        await supabase
          .from('engagex_lead_search_history')
          .update({ results_count: Math.max(mergedCount, liveResults.length + (data?.results || []).length) })
          .eq('workspace_id', activeWorkspace?.id)
          .eq('id', lastHistoryId);
        void loadHistory();
      }
      setNotice((data?.results || []).length ? 'More Google Maps businesses loaded.' : 'No more results available for this search.');
    } catch (e:any) {
      setNotice(e?.message || 'Could not load more results.');
    } finally {
      setSearching(false);
    }
  };



  const normPhone = contactPhone;
  const normEmail = contactEmail;
  const crmKeyFor = (r:any) => normPhone(r.phone) || normEmail(r.email) || '';

  const crmPhoneSet = useMemo(
    () => new Set((contacts || []).map((c:any) => normPhone(c.mobile)).filter(Boolean)),
    [contacts]
  );
  const crmEmailSet = useMemo(
    () => new Set((contacts || []).map((c:any) => normEmail(c.email)).filter(Boolean)),
    [contacts]
  );

  const isInCrm = (r:any) => {
    const p = normPhone(r.phone);
    const e = normEmail(r.email);
    const key = crmKeyFor(r);
    return (!!p && crmPhoneSet.has(p)) || (!!e && crmEmailSet.has(e)) || (!!key && addedCrmKeys.has(key));
  };

  const addOneToCrm = async (r:any) => {
    if (!activeWorkspace?.id) return;
    if (!String(r.phone || '').trim() && !String(r.email || '').trim()) {
      setNotice('This result has no public phone or email, so it cannot be added to Contact Management.');
      return;
    }
    if (isInCrm(r)) {
      setNotice('This business is already in Contact Management.');
      return;
    }

    try {
      await addContact(prospectToContact({...r,location:[area.trim(),location.trim()].filter(Boolean).join(', ')}));
      const key = crmKeyFor(r);
      if (key) setAddedCrmKeys(prev => new Set(prev).add(key));
      setNotice(r.business_name + ' added to Contact Management.');
    } catch (e) { setNotice((e as Error).message || 'Could not save this contact.'); }
  };

  const allLiveSelected = liveResults.length > 0 && liveResults.every((r:any,i:number) =>
    !!selectedLive[r.external_id || String(i)]
  );

  const toggleSelectAllLive = (checked:boolean) => {
    if (!checked) {
      setSelectedLive({});
      return;
    }
    const next: Record<string, boolean> = {};
    liveResults.forEach((r:any,i:number) => {
      next[r.external_id || String(i)] = true;
    });
    setSelectedLive(next);
  };

  const saveLiveProspects = async () => {
    if (!activeWorkspace?.id || saving) return;
    const selected = liveResults.filter((r,i) => selectedLive[r.external_id || String(i)]);
    if (!selected.length) { setNotice('Select at least one live result first.'); return; }
    setSaving(true); setNotice('');
    try {
      const payload = selected.map((r:any) => ({
        workspace_id:activeWorkspace.id,
        source:r.source==='google_places'||r.source==='google_web'?'google_maps':'web_search',
        business_name:r.business_name, category:r.category||category.trim()||null,
        location:[area.trim(),location.trim()].filter(Boolean).join(', ')||null,
        address:r.address||null, phone:r.phone||null, email:r.email||null, website:r.website||null,
        rating:r.rating, source_url:r.source_url||null, business_type:r.business_type||null,
        match_score:r.match_score??null, lead_score:r.lead_score??null,
        recommended_product:r.recommended_product||null, source_domain:r.source_domain||null,
        enrichment_status:r.enrichment_status||'basic', search_history_id:lastHistoryId, status:'new', outreach_eligibility:'review_required'
      }));
      const {data:existing,error:existingError}=await supabase.from('engagex_prospects').select('source,business_name,phone,website').eq('workspace_id',activeWorkspace.id);
      if(existingError) throw new Error(existingError.message);
      const norm=(value:unknown)=>String(value||'').trim().toLowerCase();
      const keyOf=(row:any)=>[norm(row.source),norm(row.business_name),normPhone(row.phone),norm(row.website)].join('|');
      const keys=new Set((existing||[]).map(keyOf)); let saved=0;
      for(const prospect of payload) {
        const key=keyOf(prospect); if(keys.has(key)) continue;
        const {data:created,error}=await supabase.from('engagex_prospects').insert(prospect).select('*').single();
        if(error&&error.code!=='23505') throw new Error(error.message);
        keys.add(key);
        if(!error) {
          saved++;
          await syncEngageXRecord(activeWorkspace,'prospect',created);
        }
      }
      const plan=planProspectImport(payload,contacts);
      const result=await importContacts(plan.items);

      if (lastHistoryId) {
        const phones = payload.map((p:any)=>normPhone(p.phone)).filter(Boolean);
        const emails = payload.map((p:any)=>normEmail(p.email)).filter(Boolean);
        const { data: contactRows } = await supabase
          .from('engagex_contacts')
          .select('id,mobile,email,tags')
          .eq('workspace_id',activeWorkspace.id);

        const linkedIds = (contactRows || [])
          .filter((x:any)=>Array.isArray(x.tags) && x.tags.includes('lead-intelligence'))
          .filter((x:any)=>{
            const p=normPhone(x.mobile), e=normEmail(x.email);
            return (p && phones.includes(p)) || (e && emails.includes(e));
          })
          .map((x:any)=>x.id);

        if (linkedIds.length) {
          await supabase
            .from('engagex_contacts')
            .update({ source_search_history_id:lastHistoryId })
            .eq('workspace_id',activeWorkspace.id)
            .in('id',linkedIds);
        }
      }

      setAddedCrmKeys(prev=>new Set([...prev,...payload.map(crmKeyFor).filter(Boolean)]));
      const message=`${result.inserted} contacts added · ${plan.duplicates+result.duplicates} duplicates skipped · ${plan.missing} without phone/email · ${saved} new prospect records saved.`;
      setSelectedLive({});
      if(lastHistoryId) {
        const previous=history.find(h=>h.id===lastHistoryId)?.saved_count||0;
        const {error}=await supabase.from('engagex_lead_search_history').update({saved_count:previous+result.inserted}).eq('workspace_id',activeWorkspace.id).eq('id',lastHistoryId);
        if(error) throw new Error('Contacts saved, but search history could not update: '+error.message);
      }
      await load(); await loadHistory(); setNotice(message);
    } catch(e) { setNotice((e as Error).message || 'Could not save selected results.'); }
    finally { setSaving(false); }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      const matchesQuery = !q || [r.business_name, r.phone, r.email, r.website, r.address].some(v => (v || '').toLowerCase().includes(q));
      const matchesSource = source === 'all' || r.source === source;
      const matchesCategory = !category.trim() || (r.category || '').toLowerCase().includes(category.trim().toLowerCase());
      const matchesLocation = !location.trim() || (r.location || r.address || '').toLowerCase().includes(location.trim().toLowerCase());
      return matchesQuery && matchesSource && matchesCategory && matchesLocation;
    });
  }, [rows, query, source, category, location]);

  const saveManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkspace?.id || !form.business_name.trim()) return;
    setNotice('');
    const { data: created, error } = await supabase.from('engagex_prospects').insert({
      ...form,
      workspace_id: activeWorkspace.id,
      business_name: form.business_name.trim(),
      category: form.category.trim() || null,
      location: form.location.trim() || null,
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim().toLowerCase() || null,
      website: form.website.trim() || null,
      source_url: form.source_url.trim() || null,
      notes: form.notes.trim() || null,
      outreach_eligibility: 'review_required'
    }).select('*').single();
    if (error) {
      setNotice(error.code === '23505' ? 'Duplicate prospect skipped.' : error.message);
      return;
    }
    await syncEngageXRecord(activeWorkspace,'prospect',created);
    setForm({ source: 'manual', business_name: '', category: '', location: '', address: '', phone: '', email: '', website: '', source_url: '', notes: '' });
    setShowAdd(false);
    await load();
  };

  const exportCsv = () => {
    const header = ['Business','Source','Category','Location','Phone','Email','Website','Status','Outreach Eligibility'];
    const lines = filtered.map(r => [
      r.business_name, sourceLabel[r.source], r.category || '', r.location || '', r.phone || '', r.email || '', r.website || '', r.status, r.outreach_eligibility
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'engagex-lead-intelligence.csv';
    a.click();
    URL.revokeObjectURL(url);
  };


  const applyQuickCity = (city:string) => {
    setLocation(city);
    setArea('');
  };

  const exportLiveExcel = () => {
    if (!liveResults.length) {
      setNotice('Run a search first.');
      return;
    }
    const rows = liveResults.map((r:any) => ({
      Business: r.business_name || '',
      Category: r.business_type || r.category || '',
      Location: [area, location].filter(Boolean).join(', '),
      Address: r.address || '',
      Mobile: r.phone || '',
      Email: r.email || '',
      Website: r.website || '',
      Score: r.lead_score ?? r.match_score ?? '',
      'Recommended Product': r.recommended_product || '',
      'CRM Status': isInCrm(r) ? 'In CRM' : 'Not Added'
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lead Search');
    XLSX.writeFile(wb, 'engagex_lead_search.xlsx');
  };

  const openGoogleMap = () => {
    const q = [category || query || 'businesses', area, location].filter(Boolean).join(' ');
    window.open('https://www.google.com/maps/search/' + encodeURIComponent(q), '_blank', 'noopener,noreferrer');
  };


  const removeSearchHistoryBatch = async (h: SearchHistory) => {
    if (!activeWorkspace?.id) return;
    if (!window.confirm('Remove this search batch from Search History, saved prospects, and Lead Intelligence contacts?')) return;

    setNotice('');
    const { data: linkedContacts, error: readContactsError } = await supabase
      .from('engagex_contacts')
      .select('id')
      .eq('workspace_id', activeWorkspace.id)
      .eq('source_search_history_id', h.id);
    if (readContactsError) { setNotice(readContactsError.message); return; }

    const { data: linkedProspects, error: readProspectsError } = await supabase
      .from('engagex_prospects')
      .select('id')
      .eq('workspace_id', activeWorkspace.id)
      .eq('search_history_id', h.id);
    if (readProspectsError) { setNotice(readProspectsError.message); return; }

    const contactIds = (linkedContacts || []).map((x:any)=>x.id);
    const prospectIds = (linkedProspects || []).map((x:any)=>x.id);

    if (contactIds.length) {
      const { error } = await supabase
        .from('engagex_contacts')
        .delete()
        .eq('workspace_id', activeWorkspace.id)
        .in('id', contactIds);
      if (error) { setNotice(error.message); return; }
    }

    if (prospectIds.length) {
      const { data: deletedProspects, error } = await supabase
        .from('engagex_prospects')
        .delete()
        .eq('workspace_id', activeWorkspace.id)
        .in('id', prospectIds)
        .select('id');
      if (error) { setNotice(error.message); return; }
      for (const row of deletedProspects || []) {
        await deleteEngageXRecordFromMainCrm(activeWorkspace,'prospect',row.id);
      }
    }

    const { error: historyError } = await supabase
      .from('engagex_lead_search_history')
      .delete()
      .eq('workspace_id', activeWorkspace.id)
      .eq('id', h.id);
    if (historyError) { setNotice(historyError.message); return; }

    setHistory(prev=>prev.filter(x=>x.id!==h.id));
    setRows(prev=>prev.filter(x=>!prospectIds.includes(x.id)));
    setNotice('Search batch removed: ' + prospectIds.length + ' prospect(s) and ' + contactIds.length + ' Lead Intelligence contact(s).');
  };

  const kpis = useMemo(() => ({
    searches: history.length,
    results: history.reduce((sum, h) => sum + Number(h.results_count || 0), 0),
    saved: history.reduce((sum, h) => sum + Number(h.saved_count || 0), 0),
    locations: new Set(history.map(h => [h.area, h.city].filter(Boolean).join(', ')).filter(Boolean)).size
  }), [history]);

  return (
    <CommercialShell
      title="EngageX Lead Intelligence"
      subtitle="Discover, organize and qualify business prospects by source, category and location for Savrdh Technology outreach workflows."
    >
      <div style={{maxWidth:1540,margin:'0 auto',padding:'2px 2px 24px'}}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:16, marginBottom:18 }}>
        {[
          ['TOTAL SEARCHES', kpis.searches, 'Search history records'],
          ['RESULTS FOUND', kpis.results, 'Google Maps results discovered'],
          ['SAVED TO CONTACTS', kpis.saved, 'Businesses saved for review'],
          ['LOCATIONS SEARCHED', kpis.locations, 'Unique city / area combinations']
        ].map(([label,value,note]) => (
          <article key={String(label)} style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:16,padding:'18px 20px',minHeight:112,boxShadow:'0 8px 24px rgba(15,23,42,.04)'}}>
            <span style={{fontSize:10,fontWeight:900,color:'#78909c',letterSpacing:.8}}>{label}</span>
            <strong style={{display:'block',fontSize:32,lineHeight:1.05,margin:'9px 0 6px'}}>{Number(value).toLocaleString()}</strong>
            <small style={{fontSize:10,color:'#94a3b8'}}>{note}</small>
          </article>
        ))}
      </div>

      <section style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:16,padding:'14px 18px',marginBottom:14,boxShadow:'0 8px 24px rgba(15,23,42,.035)'}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span style={{fontSize:10,fontWeight:900,color:'#64748b',letterSpacing:.4}}>QUICK CITIES:</span>
            {['Mumbai','Delhi','Bengaluru','Pune','Hyderabad','Ahmedabad','Bhopal'].map(city=>(
              <button
                key={city}
                onClick={()=>applyQuickCity(city)}
                style={{border:0,borderRadius:7,padding:'6px 10px',background:location===city?'#dbeafe':'#f1f5f9',color:location===city?'#1d4ed8':'#475569',fontSize:10,fontWeight:800,cursor:'pointer'}}
              >
                {city}
              </button>
            ))}
          </div>
          <div style={{display:'flex',alignItems:'center',gap:16,fontSize:10,fontWeight:800}}>
            <span style={{display:'flex',alignItems:'center',gap:5,color:'#64748b'}}>
              <span style={{width:12,height:12,border:'1px solid #94a3b8',borderRadius:2,display:'inline-block'}}></span>
              WhatsApp Provider
            </span>
            <span style={{display:'flex',alignItems:'center',gap:5,color:'#64748b'}}>
              <span style={{width:12,height:12,border:'1px solid #94a3b8',borderRadius:2,display:'inline-block'}}></span>
              Verified Email
            </span>
          </div>
        </div>
      </section>

      <section style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:16,padding:20,marginBottom:18,boxShadow:'0 8px 24px rgba(15,23,42,.035)'}}>
        <div style={{display:'grid',gridTemplateColumns:'minmax(180px,1.5fr) minmax(110px,.8fr) minmax(140px,1fr) minmax(150px,1fr) minmax(130px,.9fr) auto auto auto',gap:8,alignItems:'center'}}>
          <div style={{position:'relative'}}>
            <Search size={17} style={{position:'absolute',left:12,top:14,color:'#94a3b8'}}/>
            <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search company, phone, email, website..." style={{width:'100%',padding:'13px 12px 13px 38px',border:'1px solid #dbe7ee',borderRadius:9}}/>
          </div>
          <select value={source} onChange={e=>setSource(e.target.value as any)} style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}>
            <option value="all">All sources</option>
            <option value="google_maps">Google Maps</option>
            <option value="indiamart">IndiaMART</option>
            <option value="justdial">Justdial</option>
            <option value="csv">CSV Import</option>
            <option value="manual">Manual</option>
          </select>
          <input value={category} onChange={e=>setCategory(e.target.value)} placeholder="Business / Category (optional)" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
          <input value={area} onChange={e=>setArea(e.target.value)} placeholder="Area / Locality e.g. Mandideep" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
          <input value={location} onChange={e=>setLocation(e.target.value)} placeholder="City e.g. Bhopal" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
          <button onClick={runLiveSearch} disabled={searching} className="primaryBtn small"><Search size={14}/> {searching ? 'Searching…' : 'Search Live'}</button>
          <button onClick={()=>setShowAdd(v=>!v)} className="primaryBtn small"><Plus size={14}/> Add</button>
          <button onClick={exportCsv} style={{padding:'9px 10px',border:'1px solid #dbe7ee',borderRadius:9,background:'#fff',cursor:'pointer',fontWeight:800,fontSize:10,display:'inline-flex',gap:5,alignItems:'center'}}><Download size={13}/> Export</button>
        </div>
      </section>

      {liveResults.length > 0 && (
        <section style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:16,overflow:'hidden',marginBottom:18,boxShadow:'0 10px 28px rgba(15,23,42,.04)'}}>
          <div style={{padding:'12px 14px',borderBottom:'1px solid #e8eef2',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <button
                onClick={()=>toggleSelectAllLive(!allLiveSelected)}
                style={{padding:'9px 13px',border:'1px solid #cbd5e1',borderRadius:10,background:'#fff',fontWeight:800,fontSize:11,cursor:'pointer'}}
              >
                {allLiveSelected ? 'Deselect All' : `Select All (${liveResults.length})`}
              </button>

              <button
                onClick={saveLiveProspects}
                disabled={saving}
                className="primaryBtn small"
                style={{padding:'10px 15px',background:'#16a34a'}}
              >
                <UserPlus size={14}/> Add {Object.values(selectedLive).filter(Boolean).length || liveResults.length} to CRM Contacts
              </button>

              <button
                onClick={()=>setNotice('Bulk WhatsApp can be used only for contacts with recorded WhatsApp consent.')}
                style={{padding:'10px 15px',border:0,borderRadius:9,background:'#7c3aed',color:'#fff',fontWeight:900,fontSize:10,cursor:'pointer'}}
              >
                <MessageCircle size={14}/> Broadcast WhatsApp
              </button>
            </div>

            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <button onClick={exportLiveExcel} style={{padding:'9px 12px',border:'1px solid #cbd5e1',borderRadius:9,background:'#fff',fontWeight:800,fontSize:10,cursor:'pointer'}}>
                Export Excel (.xlsx)
              </button>
              <button onClick={openGoogleMap} style={{padding:'9px 12px',border:'1px solid #bfdbfe',borderRadius:9,background:'#eff6ff',color:'#1d4ed8',fontWeight:800,fontSize:10,cursor:'pointer'}}>
                <MapPin size={13}/> Interactive Google Map
              </button>
              <button onClick={exportCsv} style={{padding:'9px 12px',border:'1px solid #cbd5e1',borderRadius:9,background:'#fff',fontWeight:800,fontSize:10,cursor:'pointer'}}>
                Export CSV
              </button>
              <div style={{display:'flex',border:'1px solid #cbd5e1',borderRadius:9,overflow:'hidden'}}>
                <button onClick={()=>setResultView('list')} style={{padding:'8px 10px',border:0,background:resultView==='list'?'#0f172a':'#fff',color:resultView==='list'?'#fff':'#64748b',cursor:'pointer'}}>☷</button>
                <button onClick={()=>setResultView('grid')} style={{padding:'8px 10px',border:0,background:resultView==='grid'?'#0f172a':'#fff',color:resultView==='grid'?'#fff':'#64748b',cursor:'pointer'}}>▦</button>
              </div>
            </div>
          </div>

          {resultView === 'list' ? (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:1120,tableLayout:'fixed'}}>
                <thead>
                  <tr style={{background:'#f8fafc',color:'#475569'}}>
                    <th style={{width:'4%',padding:'14px 10px',textAlign:'center',fontSize:10}}>
                      <input type="checkbox" checked={allLiveSelected} onChange={e=>toggleSelectAllLive(e.target.checked)} style={{width:17,height:17}}/>
                    </th>
                    <th style={{width:'22%',padding:'14px 10px',textAlign:'left',fontSize:10}}>PROSPECT NAME & ROLE</th>
                    <th style={{width:'17%',padding:'14px 10px',textAlign:'left',fontSize:10}}>COMPANY & INDUSTRY</th>
                    <th style={{width:'17%',padding:'14px 10px',textAlign:'left',fontSize:10}}>LOCATION (CITY / STATE)</th>
                    <th style={{width:'14%',padding:'14px 10px',textAlign:'left',fontSize:10}}>MOBILE / WHATSAPP</th>
                    <th style={{width:'13%',padding:'14px 10px',textAlign:'left',fontSize:10}}>BUSINESS EMAIL</th>
                    <th style={{width:'6%',padding:'14px 8px',textAlign:'center',fontSize:10}}>SCORE</th>
                    <th style={{width:'7%',padding:'14px 8px',textAlign:'center',fontSize:10}}>CRM ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {liveResults.map((r:any,i:number)=>{
                    const key=r.external_id || String(i);
                    const inCrm = isInCrm(r);
                    const hasContact = !!String(r.phone || '').trim() || !!String(r.email || '').trim();
                    return (
                      <tr key={key} style={{borderTop:'1px solid #e8eef2',background:selectedLive[key]?'#eff8ff':'#fff'}}>
                        <td style={{padding:'16px 10px',textAlign:'center'}}>
                          <input type="checkbox" checked={!!selectedLive[key]} onChange={e=>setSelectedLive(prev=>({...prev,[key]:e.target.checked}))} style={{width:17,height:17}}/>
                        </td>
                        <td style={{padding:'16px 10px',verticalAlign:'top'}}>
                          <b style={{display:'block',fontSize:13,color:'#0f172a',lineHeight:1.35}}>{r.business_name}</b>
                          <small style={{display:'block',fontSize:10,color:'#64748b',marginTop:4}}>
                            {r.business_type || r.category || 'Business Prospect'}
                          </small>
                        </td>
                        <td style={{padding:'16px 10px',verticalAlign:'top'}}>
                          <b style={{display:'block',fontSize:12,color:'#1e293b'}}>{r.business_name}</b>
                          <span style={{display:'inline-block',marginTop:6,padding:'3px 8px',borderRadius:6,background:'#e0f2fe',color:'#0369a1',fontSize:9,fontWeight:900}}>
                            {r.category || r.business_type || 'Google Business'}
                          </span>
                        </td>
                        <td style={{padding:'16px 10px',verticalAlign:'top'}}>
                          <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                            <MapPin size={13} style={{color:'#ef4444',marginTop:2,flex:'0 0 auto'}}/>
                            <div>
                              <b style={{fontSize:11,color:'#334155'}}>{[area, location].filter(Boolean).join(', ') || '—'}</b>
                              <small style={{display:'block',fontSize:9,color:'#64748b',marginTop:3,lineHeight:1.4}}>{r.address || 'Google Maps listing'}</small>
                            </div>
                          </div>
                        </td>
                        <td style={{padding:'16px 10px',verticalAlign:'top'}}>
                          <b style={{fontSize:12,color:'#0f172a'}}>{r.phone || '—'}</b>
                          {r.phone && <div style={{marginTop:5,display:'flex',alignItems:'center',gap:5,color:'#16a34a',fontSize:9,fontWeight:800}}><MessageCircle size={12}/> WhatsApp</div>}
                        </td>
                        <td style={{padding:'16px 10px',verticalAlign:'top',wordBreak:'break-word'}}>
                          {r.email ? <b style={{fontSize:10,color:'#0284c7'}}>{r.email}</b> : r.website ? <a href={r.website} target="_blank" rel="noreferrer" style={{fontSize:10,color:'#0284c7',fontWeight:800}}>Open Website</a> : <span style={{fontSize:10,color:'#94a3b8'}}>—</span>}
                        </td>
                        <td style={{padding:'16px 8px',textAlign:'center',verticalAlign:'top'}}>
                          <span style={{display:'inline-block',padding:'5px 9px',borderRadius:999,background:(r.lead_score||0)>=85?'#dcfce7':'#e0f2fe',color:(r.lead_score||0)>=85?'#15803d':'#0369a1',fontWeight:900,fontSize:11}}>
                            {r.lead_score ?? r.match_score ?? '—'}{(r.lead_score ?? r.match_score) != null ? '%' : ''}
                          </span>
                        </td>
                        <td style={{padding:'16px 8px',textAlign:'center',verticalAlign:'top'}}>
                          {inCrm ? (
                            <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'7px 9px',borderRadius:8,background:'#dcfce7',color:'#15803d',fontWeight:900,fontSize:10}}>
                              <Check size={13}/> In CRM
                            </span>
                          ) : (
                            <button
                              onClick={()=>void addOneToCrm(r)}
                              disabled={!hasContact}
                              style={{display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5,padding:'8px 10px',border:0,borderRadius:8,background:hasContact?'#0284c7':'#e2e8f0',color:hasContact?'#fff':'#94a3b8',fontWeight:900,fontSize:9,cursor:hasContact?'pointer':'not-allowed'}}
                            >
                              <UserPlus size={13}/> Add to Contacts
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12,padding:14}}>
              {liveResults.map((r:any,i:number)=>{
                const key=r.external_id || String(i);
                const inCrm=isInCrm(r);
                return (
                  <article key={key} style={{border:'1px solid #e2e8f0',borderRadius:12,padding:14,background:'#fff'}}>
                    <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                      <input type="checkbox" checked={!!selectedLive[key]} onChange={e=>setSelectedLive(prev=>({...prev,[key]:e.target.checked}))}/>
                      <span style={{fontSize:10,fontWeight:900,color:'#15803d'}}>{r.lead_score ?? r.match_score ?? '—'}%</span>
                    </div>
                    <h4 style={{fontSize:14,margin:'10px 0 4px'}}>{r.business_name}</h4>
                    <div style={{fontSize:10,color:'#64748b'}}>{r.business_type || r.category || 'Business'}</div>
                    <div style={{fontSize:10,color:'#475569',marginTop:8}}>{r.phone || 'No phone'}</div>
                    <div style={{fontSize:10,color:'#475569',marginTop:4}}>{[area,location].filter(Boolean).join(', ') || '—'}</div>
                    <button
                      onClick={()=>void addOneToCrm(r)}
                      disabled={inCrm || (!r.phone && !r.email)}
                      className="primaryBtn small"
                      style={{marginTop:12,width:'100%',opacity:inCrm?0.7:1}}
                    >
                      {inCrm ? 'In CRM' : 'Add to Contacts'}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {notice && <div className="notice" style={{marginBottom:12}}>{notice}</div>}

      {showAdd && (
        <form onSubmit={saveManual} style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:14,padding:16,marginBottom:14}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:9}}>
            <select value={form.source} onChange={e=>setForm({...form,source:e.target.value as Prospect['source']})} style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}>
              <option value="manual">Manual</option><option value="csv">CSV Import</option><option value="google_maps">Google Maps</option><option value="indiamart">IndiaMART</option><option value="justdial">Justdial</option>
            </select>
            <input required value={form.business_name} onChange={e=>setForm({...form,business_name:e.target.value})} placeholder="Business name" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.category} onChange={e=>setForm({...form,category:e.target.value})} placeholder="Category" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.location} onChange={e=>setForm({...form,location:e.target.value})} placeholder="Location" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} placeholder="Public business phone" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="Public business email" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.website} onChange={e=>setForm({...form,website:e.target.value})} placeholder="Website" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
            <input value={form.source_url} onChange={e=>setForm({...form,source_url:e.target.value})} placeholder="Source URL" style={{padding:13,border:'1px solid #dbe7ee',borderRadius:10,fontSize:12}}/>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="primaryBtn small" type="submit">Save Prospect</button></div>
        </form>
      )}

      <section style={{background:'#fff',border:'1px solid #dfe9ed',borderRadius:16,overflow:'hidden',boxShadow:'0 10px 28px rgba(15,23,42,.04)'}}>
        <div style={{padding:'16px 18px',borderBottom:'1px solid #edf2f4',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <b style={{fontSize:15}}>Search History</b>
            <small style={{display:'block',fontSize:9,color:'#94a3b8',marginTop:2}}>What was searched, where it was searched, how many results were found, and how many were saved</small>
          </div>
          <div style={{fontSize:9,color:'#64748b'}}>{history.length} searches</div>
        </div>
        <div style={{overflowX:'hidden'}}>
          <table className="dashTable" style={{marginTop:0,width:'100%',tableLayout:'fixed'}}>
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Search / Category</th>
                <th>Area</th>
                <th>City</th>
                <th>Source</th>
                <th>Results</th>
                <th>Saved</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {history.length===0 ? (
                <tr><td colSpan={8}>No search history yet. Run a Google Maps search above.</td></tr>
              ) : history.map(h=>(
                <tr key={h.id}>
                  <td>{new Date(h.created_at).toLocaleString('en-IN')}</td>
                  <td><b>{h.category || h.search_term || 'Businesses'}</b>{h.search_term && h.category && <small style={{display:'block',fontSize:9,color:'#94a3b8'}}>{h.search_term}</small>}</td>
                  <td>{h.area || '—'}</td>
                  <td>{h.city || '—'}</td>
                  <td>Google Maps</td>
                  <td><span className="dashBadge">{h.results_count}</span></td>
                  <td><span className="dashBadge" style={{background:h.saved_count ? '#ecfdf5':'#f8fafc',color:h.saved_count ? '#047857':'#64748b'}}>{h.saved_count}</span></td>
                  <td>
                    <button
                      onClick={()=>void removeSearchHistoryBatch(h)}
                      style={{display:'inline-flex',alignItems:'center',gap:5,padding:'6px 9px',border:'1px solid #fecaca',borderRadius:8,background:'#fff',color:'#b91c1c',fontSize:9,fontWeight:900,cursor:'pointer'}}
                    >
                      <Trash2 size={12}/> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </CommercialShell>
  );
};
