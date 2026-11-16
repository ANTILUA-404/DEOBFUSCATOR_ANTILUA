-- Build-time smoke test for the Luau CLI compiled by build_luau.py.
--
-- Luau's command line has no -e/--version (measured: "Unrecognized option"),
-- so the Dockerfile runs this file instead. It fails loudly, with a non-zero
-- exit, if the interpreter or the vector build is not what the Luraph engine
-- expects at runtime.

local function check(name: string, ok: boolean)
	if not ok then
		io.stderr:write("smoke failed: " .. name .. "\n")
		os.exit(1)
	end
	print("ok " .. name)
end

check("_VERSION", type(_VERSION) == "string")
check("bit32", type(bit32) == "table" and bit32.band(0xFF, 0x0F) == 0x0F)
check("buffer", type(buffer) == "table")
check("table.freeze", type(table.freeze) == "function")
check("typeof", typeof(1) == "number")

-- runtime/envlog.luau needs the vector metatable to still be writable so it can
-- add Roblox's Vector3 members. build_luau.py patches lveclib.cpp to skip the
-- lua_setreadonly call; stock Luau binaries report isfrozen() == true here.
local v = vector.create(1, 2, 3)
check("vector build", typeof(v) == "vector")
check("vector xyz", v.x == 1 and v.y == 2 and v.z == 3)

local mt = getmetatable(v)
check("vector metatable is a table", type(mt) == "table")
check("vector metatable is writable", not table.isfrozen(mt))

print("luau smoke ok")
