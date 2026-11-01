import { describe, it, expect, vi } from 'vitest';
import { createThemeIconController, pngToIco } from '../themeIcons';
describe('theme window icons',()=>{
 it('supports macOS windows without setIcon through the dock callback',()=>{const win={isDestroyed:()=>false},taskbar=vi.fn();const icons=createThemeIconController({windows:()=>[win],image:()=>({isEmpty:()=>false}),taskbar});expect(()=>icons.apply('claude')).not.toThrow();expect(taskbar).toHaveBeenCalledOnce()});
 it('updates taskbar branding with the window icon and restores the original theme',()=>{
  const win={isDestroyed:()=>false,setIcon:vi.fn()},taskbar=vi.fn(),image={isEmpty:()=>false};const icons=createThemeIconController({windows:()=>[win],image:()=>image,taskbar});
  icons.apply('claude');icons.apply('antigravity');expect(taskbar.mock.calls.map(call=>call[1])).toEqual(['claude','antigravity']);expect(taskbar).toHaveBeenCalledWith(win,'antigravity',image);
 });
 it('packs a 256px PNG into a Windows ICO directory without changing its pixel payload',()=>{
  const png=Buffer.from('fixture-png');const ico=pngToIco(png);expect(ico.readUInt16LE(2)).toBe(1);expect(ico.readUInt16LE(4)).toBe(1);expect(ico.readUInt32LE(18)).toBe(22);expect(ico.subarray(22)).toEqual(png);
 });

 it('switches existing windows and restores the original icon without repeatedly setting unchanged icons',()=>{
  const win={isDestroyed:()=>false,setIcon:vi.fn()};const image=vi.fn((data:string)=>({data,isEmpty:()=>false}));
  const icons=createThemeIconController({windows:()=>[win],image});
  icons.apply('antigravity');const original=win.setIcon.mock.calls[0][0];icons.apply('claude');const claude=win.setIcon.mock.calls[1][0];expect(claude).not.toBe(original);
  expect(icons.apply('claude').changed).toBe(0);icons.apply('antigravity');expect(win.setIcon.mock.calls[2][0]).toBe(original);expect(image).toHaveBeenCalledTimes(2);
 });
 it('uses the selected theme for new windows and skips destroyed windows',()=>{
  const old={isDestroyed:()=>true,setIcon:vi.fn()},fresh={isDestroyed:()=>false,setIcon:vi.fn()};const image={isEmpty:()=>false};
  const icons=createThemeIconController({windows:()=>[old],image:()=>image},'claude');icons.apply('claude');icons.windowCreated(fresh);
  expect(old.setIcon).not.toHaveBeenCalled();expect(fresh.setIcon).toHaveBeenCalledWith(image);
 });
 it('leaves the window icon unchanged if the asset cannot be decoded',()=>{
  const win={isDestroyed:()=>false,setIcon:vi.fn()};const icons=createThemeIconController({windows:()=>[win],image:()=>({isEmpty:()=>true})});expect(()=>icons.apply('claude')).toThrow('could not be loaded');expect(win.setIcon).not.toHaveBeenCalled();
 });
});
