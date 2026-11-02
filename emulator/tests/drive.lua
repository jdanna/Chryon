-- Plays a script of timed input into the emulator. DRIVE names the script, one step a line:
--   <frame> key <hex byte>            MAXINE key code
--   <frame> mouse <dx dy 00 buttons>  8 hex digits; buttons bit 0 left, bit 1 right
--   <frame> paste <hex byte>          one character through the same path as Command-V
--   <frame> tablet <b x y>            8 hex digits: button nibble, then 12 bits each of X and Y
--   <frame> ptr <x y>                 8 hex digits for the pointer port; see pointer_w in maxine.cpp
--   <frame> press | release <n>       panel key, n is its index in artwork/make_layout.py
--   <frame> export [1]                Video and Key files, native or with 1 square pixel
--   <frame> snap | quit               snapshot, or stop
-- Run it with: run.sh -autoboot_script tests/drive.lua, with -mouseprovider none and
-- -keyboardprovider none so a live window can't disturb it.
local mem = manager.machine.devices[":maincpu"].spaces["program"]
local steps = {}
for line in io.lines(os.getenv("DRIVE")) do
	local frame, action, value = line:match("(%d+) (%a+) ?(%w*)")
	if frame then steps[#steps + 1] = { tonumber(frame), action, value } end
end

local frame = 0
emu.register_periodic(function()
	frame = frame + 1
	for _, step in ipairs(steps) do
		if step[1] == frame then
			if step[2] == "key" then mem:write_u8(0x82104000, tonumber(step[3], 16))
			elseif step[2] == "mouse" then mem:write_u32(0x82104004, tonumber(step[3], 16))
			elseif step[2] == "paste" then mem:write_u8(0x82104010, tonumber(step[3], 16))
			elseif step[2] == "tablet" then mem:write_u32(0x82104014, tonumber(step[3], 16))
			elseif step[2] == "ptr" then mem:write_u32(0x8210400c, tonumber(step[3], 16))
			elseif step[2] == "press" or step[2] == "release" then
				local index = tonumber(step[3])
				local port = manager.machine.ioport.ports[":PANEL" .. (index // 32)]
				for _, field in pairs(port.fields) do
					if field.mask == 1 << (index % 32) then field:set_value(step[2] == "press" and 1 or 0) end
				end
			elseif step[2] == "export" then mem:write_u32(0x82104008, tonumber(step[3]) or 0)
			elseif step[2] == "snap" then manager.machine.video:snapshot()
			elseif step[2] == "quit" then manager.machine:exit() end
		end
	end
end)
