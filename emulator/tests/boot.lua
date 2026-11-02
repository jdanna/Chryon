-- Boots to the Program Loader and checks the 34010 has drawn its title bar. Used by run-test.sh.
local prompt = manager.machine.devices[":prompt"].spaces["program"]
local frames = 0
emu.register_periodic(function()
	frames = frames + 1
	if frames < 500 then return end
	local lit = 0
	for x = 0, 255 do
		if prompt:read_u16((30 * 256 + x) * 16) ~= 0 then lit = lit + 1 end
	end
	print(lit > 64 and "PASS: Program Loader drawn" or "FAIL: title bar is blank")
	manager.machine:exit()
end)
