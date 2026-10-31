// Runs before first paint (inlined by the console layout), so the saved theme shows without a flash.
// The server renders Off-white (the default); a browser that saved Dark or White switches here.
export const DEFAULT_THEME = 'offwhite';
export const THEME_BOOT = `try{var t=localStorage.getItem('cx-theme'),d=document.documentElement;if(t==='dark')d.removeAttribute('data-cx-theme');else if(t==='white')d.setAttribute('data-cx-theme',t)}catch(e){}`;
