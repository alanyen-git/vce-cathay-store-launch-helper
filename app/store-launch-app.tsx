"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

type Option = { id: string; label?: string; name?: string; prefix?: string };
type Store = { id: string; name: string; code: string; status: string };
type Project = { id: string; name: string; storeId: string | null; status: string };
type Organization = { id: string; name: string; role: "admin" | "manager" | "editor" | "viewer" };
type Boot = {
  user: { displayName: string; email: string };
  organization: Organization;
  categories: (Option & { label: string; prefix: string })[];
  usageUnits: (Option & { label: string })[];
  purchasingUnits: (Option & { label: string })[];
  vendors: (Option & { name: string })[];
  stores: Store[];
  projects: Project[];
};
type Asset = {
  id: string;
  assetNo: string;
  name: string;
  unitPrice: number;
  status: string;
  createdAt: string;
  category: string;
  usageUnit: string;
  storeName: string;
  vendorName: string;
  primaryPhotoUrl: string | null;
};
type UploadedPhoto = { id: string; localUrl: string; name: string };
type AssetForm = {
  currentStoreId: string;
  originProjectId: string;
  categoryId: string;
  usageUnitId: string;
  purchasingUnitId: string;
  vendorId: string;
  name: string;
  color: string;
  specification: string;
  unitPrice: string;
  purchaseDate: string;
  warrantyEnd: string;
  notes: string;
};

const roleName = { admin: "系統管理者", manager: "專案主管", editor: "建檔人員", viewer: "檢視者" };
const currency = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

export function StoreLaunchApp() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [view, setView] = useState<"home" | "assets" | "setup">("home");
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [legacyCount, setLegacyCount] = useState(0);
  const [importingLegacy, setImportingLegacy] = useState(false);

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || "作業失敗，請稍後再試。");
    return body;
  }

  async function reloadAssets(context?: Boot) {
    const active = context ?? boot;
    if (!active) return;
    const result = await request<{ assets: Asset[] }>(`/api/assets?organizationId=${encodeURIComponent(active.organization.id)}`);
    setAssets(result.assets);
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const context = await request<Boot>("/api/bootstrap");
      setBoot(context);
      await reloadAssets(context);
    } catch (err) {
      setError(err instanceof Error ? err.message : "無法載入雲端資料。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  // Initial cloud bootstrap only; subsequent refreshes are initiated by user actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    queueMicrotask(() => setLegacyCount(readLegacyAssets().filter((asset) => asset.status !== "草稿").length));
  }, []);

  async function importLegacyAssets() {
    if (!boot) return;
    const legacy = readLegacyAssets().filter((asset) => asset.status !== "草稿");
    const migratedIds = new Set(readMigratedLegacyIds());
    const pending = legacy.filter((asset) => !migratedIds.has(asset.id));
    if (!pending.length) { setNotice("舊版正式資產都已完成匯入；草稿仍保留在本機。 "); return; }
    setImportingLegacy(true); setError("");
    const completed: string[] = [];
    const skipped: string[] = [];
    try {
      for (const legacyAsset of pending) {
        const category = boot.categories.find((item) => item.prefix === legacyCategoryPrefix[legacyAsset.category || ""]);
        const usage = boot.usageUnits.find((item) => item.label === legacyAsset.usageUnit);
        const purchasing = boot.purchasingUnits.find((item) => item.label === legacyAsset.purchasingUnit);
        const vendor = boot.vendors.find((item) => item.name === legacyAsset.vendor);
        if (!category || !usage || !purchasing || !vendor || !legacyAsset.name || Number(legacyAsset.price) <= 0 || !legacyAsset.photo?.startsWith("data:image/")) {
          skipped.push(`${legacyAsset.name || legacyAsset.id}：分類、單位、廠商、價格或照片不符合目前規則`);
          continue;
        }
        const photoResponse = await fetch(legacyAsset.photo);
        const photoBlob = await photoResponse.blob();
        const photoForm = new FormData();
        photoForm.append("organizationId", boot.organization.id);
        if (!["image/jpeg", "image/png", "image/webp"].includes(photoBlob.type)) {
          skipped.push(`${legacyAsset.name}：照片格式不受支援，請改用 JPEG、PNG 或 WebP`);
          continue;
        }
        photoForm.append("file", await normalizeImageFile(new File([photoBlob], "legacy-photo.jpg", { type: photoBlob.type })));
        const upload = await request<{ id: string }>("/api/uploads", { method: "POST", body: photoForm });
        await request("/api/assets", { method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": `legacy_${legacyAsset.id}` }, body: JSON.stringify({
          organizationId: boot.organization.id, currentStoreId: boot.stores[0]?.id, originProjectId: boot.projects[0]?.id || "", categoryId: category.id, usageUnitId: usage.id, purchasingUnitId: purchasing.id, vendorId: vendor.id,
          name: legacyAsset.name, color: legacyAsset.color || "", specification: legacyAsset.spec || "", unitPrice: Number(legacyAsset.price), purchaseDate: legacyAsset.purchaseDate || "", warrantyEnd: legacyAsset.warrantyEnd || "", notes: legacyAsset.notes || "", requestedAssetNo: legacyAsset.assetNo || "", importStatus: normalizeLegacyStatus(legacyAsset.status), uploadIds: [upload.id],
        }) });
        completed.push(legacyAsset.id);
        saveMigratedLegacyIds([...readMigratedLegacyIds(), legacyAsset.id]);
      }
      setLegacyCount(pending.length - completed.length);
      await reloadAssets();
      setNotice(`已匯入 ${completed.length} 筆舊版正式資產${skipped.length ? `；另有 ${skipped.length} 筆未匯入，仍保留在本機` : ""}。`);
      if (skipped.length) setError(`未匯入清單：${skipped.slice(0, 5).join("；")}${skipped.length > 5 ? "；其餘請於本機舊版資料中補正。" : ""}`);
    } catch (err) { setError(err instanceof Error ? `匯入中止：${err.message}` : "舊版資料匯入失敗。"); }
    finally { setImportingLegacy(false); }
  }

  const activeAssets = assets.filter((asset) => !["報廢", "遺失", "封存"].includes(asset.status));
  const total = activeAssets.reduce((sum, asset) => sum + asset.unitPrice, 0);

  if (loading) return <main className="slh-shell"><div className="slh-loading">正在準備雲端工作區…</div></main>;
  if (!boot) return <main className="slh-shell"><div className="slh-error-card"><h1>無法載入工作區</h1><p>{error || "請重新整理後再試。"}</p><button onClick={() => void load()}>重新載入</button></div></main>;

  return (
    <main className="slh-shell">
      <header className="slh-header">
        <div className="slh-brand"><span className="slh-logo">店</span><div><p>VCE × CATHAY</p><h1>VCE 國泰開店小幫手</h1></div></div>
        <div className="slh-user"><strong>{boot.organization.name}</strong><span>{roleName[boot.organization.role]}</span></div>
      </header>

      <section className="slh-content">
        {notice && <div className="slh-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="關閉提示">×</button></div>}
        {error && <div className="slh-error" role="alert">{error}<button onClick={() => setError("")} aria-label="關閉錯誤">×</button></div>}
        {view === "home" && <HomeView assets={assets} total={total} canCreate={boot.organization.role !== "viewer"} onNew={() => setShowAssetForm(true)} onAssets={() => setView("assets")} legacyCount={legacyCount} importingLegacy={importingLegacy} onImportLegacy={() => void importLegacyAssets()} />}
        {view === "assets" && <AssetsView assets={assets} canCreate={boot.organization.role !== "viewer"} onNew={() => setShowAssetForm(true)} />}
        {view === "setup" && <SetupView boot={boot} setBoot={setBoot} onNotice={setNotice} onError={setError} request={request} />}
      </section>

      <nav className="slh-nav" aria-label="主要功能">
        <NavButton active={view === "home"} icon="⌂" label="首頁" onClick={() => setView("home")} />
        <NavButton active={view === "assets"} icon="▤" label="資產" onClick={() => setView("assets")} />
        <NavButton active={view === "setup"} icon="⚙" label="公司設定" onClick={() => setView("setup")} />
      </nav>

      {showAssetForm && <AssetDialog boot={boot} onClose={() => setShowAssetForm(false)} onSaved={async (message) => { setShowAssetForm(false); setNotice(message); await reloadAssets(); }} onError={setError} request={request} />}
    </main>
  );
}

function HomeView({ assets, total, canCreate, onNew, onAssets, legacyCount, importingLegacy, onImportLegacy }: { assets: Asset[]; total: number; canCreate: boolean; onNew: () => void; onAssets: () => void; legacyCount: number; importingLegacy: boolean; onImportLegacy: () => void }) {
  const active = assets.filter((asset) => !["報廢", "遺失", "封存"].includes(asset.status));
  return <>
    <div className="slh-title-row"><div><p className="slh-kicker">雲端資料已啟用</p><h2>現場建檔，所有門市同步</h2><p className="slh-subtitle">資產編號在同一家公司內唯一，照片與列管資料皆儲存在受保護的雲端工作區。</p></div>{canCreate && <button className="slh-primary slh-desktop-action" onClick={onNew}>新增資產</button>}</div>
    <section className="slh-progress-card"><div><span className="slh-badge">雲端基礎版</span><h3>資產列管進度</h3><p>先完成資產、門市與開店專案的共同資料，再銜接 Excel、Email 與時程模組。</p></div><div className="slh-stat-grid"><Stat label="已列管" value={active.length.toString()} /><Stat label="資產總額" value={currency.format(total)} compact /><Stat label="門市／專案" value="設定中" /><Stat label="資料來源" value="雲端" /></div></section>
    {legacyCount > 0 && <section className="slh-legacy-card"><div><b>偵測到舊版本機資產</b><p>目前裝置仍有 {legacyCount} 筆正式列管資料。匯入後會保留原編號並將主照片轉入雲端；草稿不會自動列管。</p></div><button className="slh-secondary" onClick={onImportLegacy} disabled={importingLegacy}>{importingLegacy ? "匯入中…" : "匯入舊版資料"}</button></section>}
    <div className="slh-section-title"><div><h3>最近建檔</h3><p>依分類與資產編號自動排序</p></div><button className="slh-text-button" onClick={onAssets}>查看全部</button></div>
    <div className="slh-asset-list">{assets.slice(0, 4).map((asset) => <AssetRow asset={asset} key={asset.id} />)}{!assets.length && <EmptyState onNew={onNew} canCreate={canCreate} />}</div>
    {canCreate && <button className="slh-fab" onClick={onNew} aria-label="新增固定資產">＋</button>}
  </>;
}

function AssetsView({ assets, canCreate, onNew }: { assets: Asset[]; canCreate: boolean; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value ? assets.filter((asset) => [asset.assetNo, asset.name, asset.category, asset.storeName, asset.vendorName].join(" ").toLowerCase().includes(value)) : assets;
  }, [assets, query]);
  return <>
    <div className="slh-title-row"><div><p className="slh-kicker">固定資產</p><h2>雲端資產清冊</h2><p className="slh-subtitle">正式建檔時，由伺服器鎖定公司內唯一的資產編號。</p></div>{canCreate && <button className="slh-primary slh-desktop-action" onClick={onNew}>＋ 新增</button>}</div>
    <input className="slh-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋名稱、編號、門市或廠商" aria-label="搜尋資產" />
    <div className="slh-hint">資產照片最多 6 張；第一張為主照片。草稿與未完成照片不會建立正式資產。</div>
    <div className="slh-asset-list">{filtered.map((asset) => <AssetRow asset={asset} key={asset.id} />)}{!filtered.length && <EmptyState onNew={onNew} canCreate={canCreate} />}</div>
    {canCreate && <button className="slh-fab" onClick={onNew} aria-label="新增固定資產">＋</button>}
  </>;
}

function SetupView({ boot, setBoot, onNotice, onError, request }: { boot: Boot; setBoot: (value: Boot) => void; onNotice: (value: string) => void; onError: (value: string) => void; request: <T>(url: string, init?: RequestInit) => Promise<T> }) {
  const [storeName, setStoreName] = useState(""); const [storeCode, setStoreCode] = useState("");
  const [projectName, setProjectName] = useState(""); const [projectStoreId, setProjectStoreId] = useState(boot.stores[0]?.id || "");
  async function createStore(event: FormEvent) { event.preventDefault(); try { const result = await request<{ store: Store }>("/api/stores", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: boot.organization.id, name: storeName, code: storeCode }) }); setBoot({ ...boot, stores: [...boot.stores, result.store] }); setStoreName(""); setStoreCode(""); onNotice("門市已建立，可立即用於資產目前所在地。"); } catch (err) { onError(err instanceof Error ? err.message : "無法建立門市。"); } }
  async function createProject(event: FormEvent) { event.preventDefault(); try { const result = await request<{ project: Project }>("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: boot.organization.id, name: projectName, storeId: projectStoreId }) }); setBoot({ ...boot, projects: [...boot.projects, result.project] }); setProjectName(""); onNotice("開店專案已建立，可作為資產來源專案。 "); } catch (err) { onError(err instanceof Error ? err.message : "無法建立專案。"); } }
  return <>
    <div className="slh-title-row"><div><p className="slh-kicker">公司與基礎資料</p><h2>門市與開店專案</h2><p className="slh-subtitle">資產長期隸屬公司與目前門市；開店專案只記錄來源，結案後資料仍可持續管理。</p></div></div>
    <section className="slh-card"><div className="slh-section-title"><div><h3>{boot.organization.name}</h3><p>目前登入：{boot.user.email}・{roleName[boot.organization.role]}</p></div><span className="slh-badge">公司工作區</span></div><p className="slh-muted">目前版本已建立四種角色的伺服器端權限邊界；管理者可管理門市與專案，建檔人員可建立資產。</p></section>
    <section className="slh-card slh-backend-card"><div><h3>後臺管理</h3><p className="slh-muted">開啟受保護的雲端後臺，使用目前的 ChatGPT 帳戶登入。</p></div><a className="slh-secondary slh-backend-link" href={BACKEND_URL} target="_blank" rel="noreferrer">開啟後臺 ↗</a></section>
    <section className="slh-card"><h3>門市</h3><div className="slh-chip-list">{boot.stores.map((store) => <span key={store.id} className="slh-chip"><b>{store.name}</b><small>{store.code}・{store.status}</small></span>)}</div>{(boot.organization.role === "admin" || boot.organization.role === "manager") && <form className="slh-inline-form" onSubmit={createStore}><input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="門市名稱" maxLength={60} required /><input value={storeCode} onChange={(e) => setStoreCode(e.target.value.toUpperCase())} placeholder="代碼，例如 TPE01" maxLength={16} required /><button className="slh-secondary">新增門市</button></form>}</section>
    <section className="slh-card"><h3>開店專案</h3><div className="slh-chip-list">{boot.projects.map((project) => <span key={project.id} className="slh-chip"><b>{project.name}</b><small>{boot.stores.find((store) => store.id === project.storeId)?.name || "未指定門市"}・{project.status}</small></span>)}</div>{(boot.organization.role === "admin" || boot.organization.role === "manager") && <form className="slh-inline-form" onSubmit={createProject}><input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="專案名稱" maxLength={80} required /><select value={projectStoreId} onChange={(e) => setProjectStoreId(e.target.value)} required>{boot.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select><button className="slh-secondary">新增專案</button></form>}</section>
  </>;
}

function AssetDialog({ boot, onClose, onSaved, onError, request }: { boot: Boot; onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (value: string) => void; request: <T>(url: string, init?: RequestInit) => Promise<T> }) {
  const initial = (): AssetForm => ({ currentStoreId: boot.stores[0]?.id || "", originProjectId: boot.projects[0]?.id || "", categoryId: boot.categories[0]?.id || "", usageUnitId: boot.usageUnits[0]?.id || "", purchasingUnitId: boot.purchasingUnits[0]?.id || "", vendorId: boot.vendors[0]?.id || "", name: "", color: "", specification: "", unitPrice: "", purchaseDate: "", warrantyEnd: "", notes: "" });
  const [form, setForm] = useState<AssetForm>(initial); const [photos, setPhotos] = useState<UploadedPhoto[]>([]); const [uploading, setUploading] = useState(false); const [saving, setSaving] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());
  const set = (key: keyof AssetForm, value: string) => setForm((old) => ({ ...old, [key]: value }));
  async function discardPhotos(items: UploadedPhoto[]) {
    items.forEach((photo) => URL.revokeObjectURL(photo.localUrl));
    await Promise.all(items.map((photo) => request(`/api/uploads/${photo.id}?organizationId=${encodeURIComponent(boot.organization.id)}`, { method: "DELETE" }).catch(() => undefined)));
  }
  async function removePhoto(photo: UploadedPhoto) {
    setPhotos((old) => old.filter((item) => item.id !== photo.id));
    await discardPhotos([photo]);
  }
  function close() {
    void discardPhotos(photos);
    onClose();
  }
  async function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []); event.target.value = "";
    if (!files.length) return;
    if (photos.length + files.length > 6) { onError("每筆資產最多可上傳 6 張照片。"); return; }
    setUploading(true);
    const next: UploadedPhoto[] = [];
    try {
      for (const originalFile of files) {
        const file = await normalizeImageFile(originalFile);
        const body = new FormData(); body.append("organizationId", boot.organization.id); body.append("file", file);
        const result = await request<{ id: string }>("/api/uploads", { method: "POST", body });
        next.push({ ...result, localUrl: URL.createObjectURL(file), name: file.name });
      }
      setPhotos((old) => [...old, ...next]);
    } catch (err) {
      await discardPhotos(next);
      onError(err instanceof Error ? err.message : "照片上傳失敗。");
    } finally { setUploading(false); }
  }
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const result = await request<{ asset: { assetNo: string } }>("/api/assets", { method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": requestKey }, body: JSON.stringify({ ...form, organizationId: boot.organization.id, unitPrice: Number(form.unitPrice), uploadIds: photos.map((photo) => photo.id) }) }); photos.forEach((photo) => URL.revokeObjectURL(photo.localUrl)); await onSaved(`資產 ${result.asset.assetNo} 已正式列管，編號已由伺服器鎖定。`); } catch (err) { onError(err instanceof Error ? err.message : "無法完成建檔。"); } finally { setSaving(false); } }
  return <div className="slh-modal-backdrop" role="presentation"><section className="slh-modal" role="dialog" aria-modal="true" aria-label="新增固定資產"><div className="slh-modal-heading"><div><p className="slh-kicker">正式列管</p><h2>新增固定資產</h2><p>送出時由伺服器以冪等識別碼鎖定本次建檔，網路重送不會重複列管。</p></div><button className="slh-icon-button" onClick={close} aria-label="關閉">×</button></div><form onSubmit={submit}>
    <fieldset><legend>01　資產照片 <em>*</em></legend><div className="slh-photo-area">{photos.map((photo, index) => <div className="slh-photo" key={photo.id}><img src={photo.localUrl} alt={photo.name} /><button type="button" onClick={() => void removePhoto(photo)} aria-label={`移除 ${photo.name}`}>×</button>{index === 0 && <span>主照片</span>}</div>)}{photos.length < 6 && <label className="slh-upload"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectPhotos} disabled={uploading} />{uploading ? "上傳中…" : "＋ 拍照／上傳"}</label>}</div><p className="slh-field-note">最多 6 張；照片會在裝置端移除定位資訊後上傳，取消建檔時會刪除暫存檔。</p></fieldset>
    <fieldset><legend>02　識別資料</legend><div className="slh-form-grid"><Field label="目前門市" required><select value={form.currentStoreId} onChange={(e) => set("currentStoreId", e.target.value)}>{boot.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></Field><Field label="來源專案"><select value={form.originProjectId} onChange={(e) => set("originProjectId", e.target.value)}><option value="">不指定</option>{boot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="資產分類" required><select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>{boot.categories.map((category) => <option key={category.id} value={category.id}>{category.label}（{category.prefix}）</option>)}</select></Field><Field label="資產編號" required><input value="完成建檔時自動產生" disabled /></Field><Field label="資產名稱" required wide><input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="例如：雙門冷藏冰箱" required /></Field><Field label="顏色"><input value={form.color} onChange={(e) => set("color", e.target.value)} maxLength={40} placeholder="例如：銀色" /></Field><Field label="購買日期"><input type="date" value={form.purchaseDate} onChange={(e) => set("purchaseDate", e.target.value)} /></Field><Field label="規格" wide><textarea value={form.specification} onChange={(e) => set("specification", e.target.value)} maxLength={300} placeholder="品牌、型號、尺寸、容量等" /></Field></div></fieldset>
    <fieldset><legend>03　歸屬與金額</legend><div className="slh-form-grid"><Field label="使用單位" required><select value={form.usageUnitId} onChange={(e) => set("usageUnitId", e.target.value)}>{boot.usageUnits.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="採購單位" required><select value={form.purchasingUnitId} onChange={(e) => set("purchasingUnitId", e.target.value)}>{boot.purchasingUnits.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="單價（含稅）" required><input type="number" inputMode="numeric" min="1" step="1" value={form.unitPrice} onChange={(e) => set("unitPrice", e.target.value)} placeholder="例如：85000" required /></Field><Field label="提供廠商" required><select value={form.vendorId} onChange={(e) => set("vendorId", e.target.value)}>{boot.vendors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="保固到期日"><input type="date" value={form.warrantyEnd} onChange={(e) => set("warrantyEnd", e.target.value)} /></Field><Field label="備註" wide><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={400} placeholder="可記錄放置位置、驗收狀況或補充事項" /></Field></div></fieldset>
    <div className="slh-modal-actions"><button type="button" className="slh-outline" onClick={close}>取消</button><button type="submit" className="slh-primary" disabled={saving || uploading}>{saving ? "建立中…" : "完成建檔"}</button></div>
  </form></section></div>;
}

async function normalizeImageFile(file: File): Promise<File> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("照片只支援 JPEG、PNG 或 WebP 格式。");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 24_000_000) throw new Error("照片解析度過高，請改用較小的圖片。");
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > 1920 ? 1920 / longest : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("無法處理照片。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error("無法壓縮照片。");
    const baseName = file.name.replace(/\.[^.]+$/, "") || "asset-photo";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

function Field({ label, required, wide, children }: { label: string; required?: boolean; wide?: boolean; children: React.ReactNode }) { return <label className={`slh-field ${wide ? "slh-wide" : ""}`}><span>{label}{required && <em> *</em>}</span>{children}</label>; }
function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span>{label}</button>; }
function Stat({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) { return <div className="slh-stat"><span>{label}</span><b className={compact ? "slh-stat-small" : ""}>{value}</b></div>; }
function AssetRow({ asset }: { asset: Asset }) { return <article className="slh-asset-row"><div className="slh-thumb">{asset.primaryPhotoUrl ? <img src={asset.primaryPhotoUrl} alt="" /> : "▧"}</div><div><strong>{asset.name}</strong><p>{asset.assetNo}・{asset.category}・{asset.usageUnit}</p><small>{asset.storeName}・{asset.vendorName}</small></div><div className="slh-asset-price"><b>{currency.format(asset.unitPrice)}</b><span>{asset.status}</span></div></article>; }
function EmptyState({ onNew, canCreate }: { onNew: () => void; canCreate: boolean }) { return <div className="slh-empty"><b>尚未建立資產</b><p>{canCreate ? "先拍攝資產與規格貼紙，再完成第一筆正式列管。" : "目前尚無資產資料。"}</p>{canCreate && <button className="slh-primary" onClick={onNew}>新增固定資產</button>}</div>; }

type LegacyAsset = {
  id: string;
  category?: string;
  assetNo?: string;
  usageUnit?: string;
  name?: string;
  color?: string;
  spec?: string;
  purchasingUnit?: string;
  price?: number | string;
  vendor?: string;
  purchaseDate?: string;
  warrantyEnd?: string;
  notes?: string;
  status?: string;
  photo?: string;
};

const legacyCategoryPrefix: Record<string, string> = { kitchen: "KIT", bar: "BAR", dining: "DIN", furniture: "FUR", it: "IT", other: "OTH" };
const legacyStatuses = new Set(["已列管", "待盤點", "維修中", "報廢", "遺失", "封存"]);
const BACKEND_URL = "https://vce-cathay-store-launch-helper.jjaster2011.chatgpt.site";

function normalizeLegacyStatus(status?: string) {
  return legacyStatuses.has(status || "") ? status : "已列管";
}

function readLegacyAssets(): LegacyAsset[] {
  try {
    const raw = window.localStorage.getItem("storeLaunchHelperAssetsV1");
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is LegacyAsset => item && typeof item.id === "string") : [];
  } catch { return []; }
}

function readMigratedLegacyIds(): string[] {
  try {
    const raw = window.localStorage.getItem("storeLaunchHelperMigratedIdsV2");
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function saveMigratedLegacyIds(ids: string[]) {
  window.localStorage.setItem("storeLaunchHelperMigratedIdsV2", JSON.stringify(ids));
}
