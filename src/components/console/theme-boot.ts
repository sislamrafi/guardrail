// Runs before first paint (inlined by the console layout), so the saved theme shows without a flash.
// The server renders Off-white (the default); a browser that saved Dark or White switches here.
export const DEFAULT_THEME = 'offwhite';
export const THEME_BOOT = `try{var t=localStorage.getItem('cx-theme'),d=document.documentElement;if(t==='dark')d.removeAttribute('data-cx-theme');else if(t==='white')d.setAttribute('data-cx-theme',t)}catch(e){}`;

// Splash screen: on the first load in a browser, or the first load after a gap (6 hours unless changed
// in Settings), the app opens behind a short branded loading screen of 5–10 s, picked at random.
// Decided before paint so the app never flashes. ?splash=1 forces it; Settings can turn it off.
export const SPLASH_GAP_HOURS = 6;
export const SPLASH_BOOT = `try{var k='cx-last-load',n=Date.now(),l=Number(localStorage.getItem(k))||0,g=Number(localStorage.getItem('cx-splash-gap-h'))||${SPLASH_GAP_HOURS},f=/[?&]splash=1(&|$)/.test(location.search);localStorage.setItem(k,String(n));if(f||(localStorage.getItem('cx-splash-off')!=='1'&&n-l>g*36e5)){var d=document.documentElement,m=5000+Math.floor(Math.random()*5001);d.setAttribute('data-cx-splash',String(m));d.style.setProperty('--cx-splash-ms',m+'ms')}}catch(e){}`;
