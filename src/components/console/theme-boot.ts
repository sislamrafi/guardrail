// Runs before first paint (inlined by the console layout), so the saved theme shows without a flash.
export const THEME_BOOT = `try{var t=localStorage.getItem('cx-theme');if(t==='offwhite'||t==='white')document.documentElement.setAttribute('data-cx-theme',t)}catch(e){}`;
