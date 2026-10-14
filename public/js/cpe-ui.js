document.addEventListener('DOMContentLoaded', () => {
  const views = {upload:document.getElementById('uploadView'),dashboard:document.getElementById('dashboardView'),portfolio:document.getElementById('portfolioView')};
  const nav = document.querySelectorAll('.cpe-nav-btn');
  function showView(name) {
    Object.entries(views).forEach(([key,el]) => { if(el) el.hidden = key !== name; });
    nav.forEach(btn => { const active=btn.dataset.view===name;btn.classList.toggle('active',active);if(active)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current'); });
    if(name==='dashboard') document.getElementById('refreshWorkloadBtn')?.click();
    if(name==='portfolio') document.getElementById('loadWorkloadDocumentsBtn')?.click();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  nav.forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));
  const toggle=document.getElementById('cpeChatToggle'),panel=document.getElementById('cpeChatPanel'),close=document.getElementById('cpeChatClose');
  function setChat(open){panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'ปิดผู้ช่วย AI':'เปิดผู้ช่วย AI');if(open)document.getElementById('workloadQuestion')?.focus();}
  toggle?.addEventListener('click',()=>setChat(panel.hidden));
  close?.addEventListener('click',()=>setChat(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)setChat(false)});
});
