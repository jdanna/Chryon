// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Chyron MAXINE! character generator

    A VME system: a Motorola MVME162 CPU card (68040) running pSOS+, an
    "Andrea" interface board with a TMS34010 for the operator's prompt
    monitor, and Chyron frame buffer and video boards on VSB.

    There is no boot PROM dump yet, so the machine starts by loading
    /SYSTEM/PROGRAMS/PSOS straight off the pHILE volume on SCSI ID 0.

    See docs/hardware-map.md in the MaxineStudio repository.

***************************************************************************/

#include "emu.h"

#include "bus/nscsi/devices.h"
#include "bus/nscsi/hd.h"
#include "bus/rs232/rs232.h"
#include "cpu/m68000/m68040.h"
#include "cpu/tms34010/tms34010.h"
#include "imagedev/harddriv.h"
#include "machine/53c7xx.h"
#include "machine/i82586.h"
#include "machine/keyboard.h"
#include "machine/mc68681.h"
#include "machine/mc68901.h"
#include "machine/nscsi_bus.h"
#include "machine/timekpr.h"
#include "machine/z80scc.h"
#include "corestr.h"
#include "emuopts.h"
#include "fileio.h"
#include "png.h"
#include "screen.h"
#include "speaker.h"

#include "modules/lib/osdlib.h"

#include <atomic>
#include <bit>
#include <csignal>
#include <mutex>
#include <optional>
#include <cstdio>
#include <cstdlib>
#include "osdepend.h"

#include <filesystem>
#if !defined(__EMSCRIPTEN__)
#include <thread>
#endif

#if defined(__APPLE__)
#include <objc/message.h>
#include <objc/runtime.h>
#endif

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

#include "chyronfb.h"
#if !defined(__EMSCRIPTEN__)
#include "fieldcapture.h"
#endif
#include "maxine_keys.h"
#include "mcchip.h"

#include "multibyte.h"

#include <bit>
#include <deque>

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#endif

#define LOG_REGS (1U << 1)
#define LOG_CONSOLE (1U << 2)
#define LOG_HEARTBEAT (1U << 3)
#define LOG_SCSI (1U << 4)
#define VERBOSE (LOG_GENERAL | LOG_CONSOLE)
#include "logmacro.h"

#if defined(__EMSCRIPTEN__)

// From the web page's paste event, because that's the only way a browser hands over the clipboard
static std::string s_page_paste;

extern "C" EMSCRIPTEN_KEEPALIVE void maxine_paste(char const *text)
{
	s_page_paste += text;
}

// Fields so far, which is how the page shows the machine's speed
static uint32_t s_page_fields = 0;

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t maxine_fields()
{
	return s_page_fields;
}

// A PNG the page wrote to the file system for the Video Input board, or an empty path for no picture,
// until the machine takes it
static std::optional<std::string> s_page_video_input;

extern "C" EMSCRIPTEN_KEEPALIVE void maxine_video_input(char const *path)
{
	s_page_video_input = path;
}

#endif

namespace {

static volatile std::sig_atomic_t s_quit_requested = 0;

static void request_quit(int)
{
	s_quit_requested = 1;
}

#if defined(_WIN32)

// Windows only lets the active program hand over the foreground. Declared here because windows.h
// brings in macros that clash with MAME's names.
extern "C" __declspec(dllimport) int __stdcall AllowSetForegroundWindow(unsigned long process);
static constexpr unsigned long ASFW_ANY = 0xffffffff;

#endif

static constexpr unsigned RASTER_LINE_CLOCKS = 858; // at 13.5 MHz
static constexpr unsigned FIRST_ACTIVE_LINE = 21;

// The web build has no threads, sockets or stdin, so it has no capture and no command reader
#if !defined(__EMSCRIPTEN__)

// A port to send a capture to, or CAPTURE_STOP, until the machine picks it up
static constexpr int CAPTURE_STOP = -1;
static std::atomic<int> s_capture_command{0};

// A PNG for the Video Input board, or an empty path for no picture, until the machine takes it
static std::mutex s_video_input_lock;
static std::optional<std::string> s_video_input_path;

// MAXINE! Studio's commands, a line at a time: "capture <port>", "capture stop", "videoin <PNG path>" and
// "videoin off". The low-level read
// matters: getchar() would hold a stream lock that exit() needs. Node can only terminate a process on
// Windows, which loses the NVRAM, so the app closes stdin there to quit. Elsewhere it sends SIGTERM, and
// closing means the app has gone, which shouldn't lose the machine.
static void read_commands()
{
	std::string line;
	char data;
#if defined(_WIN32)
	while (_read(0, &data, 1) > 0)
#else
	while (::read(0, &data, 1) > 0)
#endif
	{
		if (data != '\n')
		{
			line += data;
			continue;
		}
		if (line == "capture stop")
			s_capture_command = CAPTURE_STOP;
		else if (line.rfind("capture ", 0) == 0)
			s_capture_command = std::atoi(line.c_str() + 8);
		else if (line.rfind("videoin ", 0) == 0)
		{
			std::lock_guard const lock(s_video_input_lock);
			s_video_input_path = (line == "videoin off") ? std::string() : line.substr(8);
		}
		line.clear();
	}
#if defined(_WIN32)
	s_quit_requested = 1;
#endif
}

#endif // !__EMSCRIPTEN__

// Read from a PAL on the real board. Licensed files on the archive's disk image carry this one.
static constexpr uint16_t SITE_ID = 0x2192;

// Visible areas. Prompts is cropped to what's drawn. Color Edit is the whole program raster, as
// exports are, because the Palette tool draws to the bottom of it. If these change, so must
// artwork/make_layout.py.
static constexpr int PROMPT_LEFT = 92;
static constexpr int PROMPT_RIGHT = 612;
static constexpr int PROMPT_TOP = 20;
static constexpr int PROMPT_BOTTOM = 472;
static constexpr int EDIT_LEFT = 0;
static constexpr int EDIT_RIGHT = 720;
static constexpr int EDIT_TOP = 0;
static constexpr int EDIT_BOTTOM = 486;

// The firmware's cursor, as the blit position it gives the 34010. The arrow's tip is that position
// less CURSOR_TIP. It starts each program at the right and bottom limits and stops at all four.
static constexpr int CURSOR_LEFT = 112;
static constexpr int CURSOR_RIGHT = 667;
static constexpr int CURSOR_TOP = 45;
static constexpr int CURSOR_BOTTOM = 455;
static constexpr int CURSOR_TIP_X = 5;
static constexpr int CURSOR_TIP_Y = 7;
static constexpr int CURSOR_IDLE_FIELDS = 8;
static constexpr int PASTE_FIELDS = 2;
static constexpr int REPEAT_DELAY_FIELDS = 30; // half a second, then a cursor key held down repeats
static constexpr int REPEAT_FIELDS = 3;

// Tablet units per Color Edit raster pixel and per Prompts pixel, measured from Logo Compose's
// crosshair and arrow. Its button 2 flips between the two. The firmware ignores lines outside its
// window, which would leave the crosshair stuck, so the pointer is held to the edges of it. That
// reaches raster x 51 to 662 and y 41 to 491.
static constexpr double TABLET_EDIT_X_SCALE = 4.937;
static constexpr double TABLET_EDIT_X_ORIGIN = 50.4; // tuned by aiming at it; the fit gives 50.66
static constexpr double TABLET_EDIT_Y_SCALE = 5.489;
static constexpr double TABLET_EDIT_Y_ORIGIN = 591.09;
static constexpr int TABLET_EDIT_X_MAX = 3016;
static constexpr int TABLET_EDIT_Y_MIN = 550;
static constexpr int TABLET_EDIT_Y_MAX = 3019;
static constexpr double TABLET_MENU_X_SCALE = 5.051;
static constexpr double TABLET_MENU_Y_SCALE = 6.838;
static constexpr double TABLET_MENU_Y_ORIGIN = 443.5;
static constexpr offs_t TABLET_FRAME_FLAG = 0x30cc4;
static constexpr int TABLET_CLICK_FIELDS = 12;

static constexpr int CURSOR_HOME_MOVES = 5; // of -127, enough to reach the top left from anywhere

// From the SDL build in emulator/build.sh
#if defined(__EMSCRIPTEN__)
extern "C" bool SDL_ShowCursor();
extern "C" bool SDL_HideCursor();
#else
extern "C" int SDL_ShowCursor(int toggle);
#endif
extern "C" void *SDL_GetKeyboardFocus();

#if defined(__APPLE__)

// The menu bar is the one control that's always there, since MAME's own menu shares a key with ERASE.
// This is the only Objective-C in the driver, so it goes through the runtime and stays a .cpp file.
enum class export_request { NONE, NATIVE, SQUARE };
static export_request s_export_requested = export_request::NONE;

template <typename R = id, typename... Args>
static R objc(id target, char const *selector, Args... args)
{
	return reinterpret_cast<R (*)(id, SEL, Args...)>(objc_msgSend)(target, sel_registerName(selector), args...);
}

static id ns_class(char const *name) { return reinterpret_cast<id>(objc_getClass(name)); }
static id ns_string(char const *text) { return objc(ns_class("NSString"), "stringWithUTF8String:", text); }

static void export_native_action(id, SEL, id) { s_export_requested = export_request::NATIVE; }
static void export_square_action(id, SEL, id) { s_export_requested = export_request::SQUARE; }

// Headless runs have no menu bar, so this does nothing there
static void add_export_menu()
{
	id const bar = objc(objc(ns_class("NSApplication"), "sharedApplication"), "mainMenu");
	if (!bar)
		return;

	Class target_class = objc_allocateClassPair(objc_getClass("NSObject"), "MaxineExportTarget", 0);
	if (!target_class)
		return;
	class_addMethod(target_class, sel_registerName("exportNative:"), reinterpret_cast<IMP>(export_native_action), "v@:@");
	class_addMethod(target_class, sel_registerName("exportSquare:"), reinterpret_cast<IMP>(export_square_action), "v@:@");
	objc_registerClassPair(target_class);
	id const target = objc(objc(reinterpret_cast<id>(target_class), "alloc"), "init");

	id const menu = objc(objc(ns_class("NSMenu"), "alloc"), "initWithTitle:", ns_string("Export"));
	auto const add_item = [&] (char const *title, char const *action, char const *key)
	{
		id const item = objc(objc(ns_class("NSMenuItem"), "alloc"), "initWithTitle:action:keyEquivalent:",
				ns_string(title), sel_registerName(action), ns_string(key));
		objc<void>(item, "setTarget:", target);
		objc<void>(menu, "addItem:", item);
	};
	add_item("Native Size (720x486)", "exportNative:", "e");
	add_item("Square Pixel (640x480)", "exportSquare:", "E"); // a capital adds Shift

	id const heading = objc(objc(ns_class("NSMenuItem"), "alloc"), "init");
	objc<void>(heading, "setTitle:", ns_string("Export"));
	objc<void>(heading, "setSubmenu:", menu);
	objc<void>(bar, "addItem:", heading);
}

// Empty if cancelled. The emulation waits here, so the picture is what was on screen. This asks
// osascript, because AppKit's own panels rely on a service that fails for a binary outside an app bundle.
static std::string choose_export_folder()
{
	FILE *const dialog = popen("osascript -e activate -e 'POSIX path of (choose folder with prompt \"Choose a folder for the Video and Key PNGs\")' 2>/dev/null", "r");
	if (!dialog)
		return std::string();

	char path[4096] = "";
	char const *const line = fgets(path, sizeof(path), dialog);
	pclose(dialog);
	if (!line)
		return std::string();
	path[strcspn(path, "\n")] = 0;
	return path;
}

#endif

static constexpr unsigned VRAM_ROW_WORDS = 256;
static constexpr unsigned PROMPT_ROWS = 512;

// Where the overlay sits relative to the frame buffer, found by lining the cursor up with text
static constexpr int OVERLAY_COLUMN_OFFSET = 10;
static constexpr int OVERLAY_ROW_OFFSET = -22;

class maxine_state : public driver_device
{
public:
	maxine_state(const machine_config &mconfig, device_type type, const char *tag)
		: driver_device(mconfig, type, tag)
		, m_maincpu(*this, "maincpu")
		, m_dram(*this, "dram")
		, m_nvram(*this, "nvram")
		, m_scsi(*this, "scsi")
		, m_siop(*this, "siop")
		, m_prompt(*this, "prompt")
		, m_vram(*this, "vram")
		, m_mcc(*this, "mcc")
		, m_scc(*this, "scc%u", 1U)
		, m_lan(*this, "lan")
		, m_fb(*this, "fb")
		, m_line_levels(*this, "line_levels")
		, m_line_level_control(*this, "line_level_control")
		, m_video_input_regs(*this, "video_input_regs")
		, m_mfp(*this, "mfp")
		, m_keyboard_duart(*this, "keyboard_duart")
		, m_panel(*this, "PANEL%u", 0U)
		, m_host_keys(*this, "HOSTKEYS")
		, m_host_shift(*this, "HOSTSHIFT")
		, m_host_hold(*this, "HOSTHOLD")
		, m_export(*this, "EXPORT")
		, m_shift_lamps(*this, "shift%u", 0U)
		, m_second_screen_label(*this, "second_screen")
		, m_serial_duart(*this, "serial_duart")
	{
	}

	void maxine(machine_config &config) ATTR_COLD;

protected:
	virtual void machine_start() override ATTR_COLD;
	virtual void machine_reset() override ATTR_COLD;

private:
	void maxine_mem(address_map &map) ATTR_COLD;
	void lan_mem(address_map &map) ATTR_COLD;
	void prompt_mem(address_map &map) ATTR_COLD;
	void cpu_space_map(address_map &map) ATTR_COLD;

	uint32_t unmapped_r(offs_t offset, uint32_t mem_mask);
	void unmapped_w(offs_t offset, uint32_t data, uint32_t mem_mask);

	TMS340X0_SCANLINE_RGB32_CB_MEMBER(prompt_scanline);
	void vram_w(offs_t offset, uint16_t data, uint16_t mem_mask);
	uint32_t prompt_update(screen_device &screen, bitmap_rgb32 &bitmap, rectangle const &cliprect);
	uint32_t edit_update(screen_device &screen, bitmap_rgb32 &bitmap, rectangle const &cliprect);

	TIMER_CALLBACK_MEMBER(heartbeat);

	TIMER_CALLBACK_MEMBER(field_tick);
#if !defined(__EMSCRIPTEN__)
	TIMER_CALLBACK_MEMBER(capture_field);
#endif
	TIMER_CALLBACK_MEMBER(key_bit);
	TIMER_CALLBACK_MEMBER(mouse_bit);
	TIMER_CALLBACK_MEMBER(tablet_bit);
	void key_w(uint8_t data);
	void host_key(uint8_t data);
	void paste_text(std::string const &text);
	void poll_host();
#if !defined(__EMSCRIPTEN__)
	void end_capture();
#endif
	void tablet_frame(int x, int y, int buttons);
	void update_tablet();
	void mouse_move(int dx, int dy, int buttons);
	void pointer_w(uint32_t data);
	void update_cursor_position();
	void update_mouse();
	int active_shift() const;
	void panel_key(uint16_t code);
	void export_outputs(bool square, std::string const &folder = std::string(), bool ask = false);
	void set_video_input(uint8_t const *rgba, int width, int height);
	void load_video_input(std::string const &path);
	bool write_snapshot(std::string filename, bitmap_rgb32 const &bitmap);
	void write_file(std::string const &path, bitmap_rgb32 const &bitmap);

	void update_irq(int state);
	int vme_irq_level() const;
	template <unsigned Channel> void bim_input_w(int state);
	uint8_t bim_r(offs_t offset);
	void bim_w(offs_t offset, uint8_t data);
	int bim_channel_level(int channel) const;
	int bim_acknowledge(int level);
	void keyboard_irq_w(int state);
	void mfp_irq_w(int state);
	void lan_port_w(offs_t offset, uint16_t data);
	uint32_t lan_r(offs_t offset, uint32_t mem_mask);
	void lan_w(offs_t offset, uint32_t data, uint32_t mem_mask);
	uint8_t iack_r(offs_t offset);

	// Plain register stores for chips not modelled yet, logged so the
	// firmware's use of them shows what needs modelling next.
	template <unsigned Size> uint8_t stub_r(char const *name, uint8_t const (&regs)[Size], offs_t offset);
	template <unsigned Size> void stub_w(char const *name, uint8_t (&regs)[Size], offs_t offset, uint8_t data);

	// Odd byte addresses: 1 B control, 3 B data, 5 A control, 7 A data
	uint8_t scc_r(int chip, offs_t offset);
	void scc_w(int chip, offs_t offset, uint8_t data);
	void console_w(int port, uint8_t data);

	uint32_t dma_r(offs_t offset, uint32_t mem_mask);
	void dma_w(offs_t offset, uint32_t data, uint32_t mem_mask);

	bool read_block(harddisk_image_device &disk, uint32_t block, uint8_t *dest);
	bool load_file(harddisk_image_device &disk, std::initializer_list<const char *> path, uint32_t address);
	void boot_stub();

	required_device<m68040_device> m_maincpu;
	required_shared_ptr<uint32_t> m_dram;
	required_device<timekeeper_device> m_nvram;
	required_device<nscsi_bus_device> m_scsi;
	required_device<ncr53c710_device> m_siop;
	required_device<tms34010_device> m_prompt;
	required_shared_ptr<uint16_t> m_vram;
	required_device<mcchip_device> m_mcc;
	required_device_array<scc85230_device, 2> m_scc;
	required_device<i82596_le32_device> m_lan;
	required_device<chyron_fb_device> m_fb;
	required_shared_ptr<uint32_t> m_line_levels;
	required_shared_ptr<uint32_t> m_line_level_control;
	required_shared_ptr<uint32_t> m_video_input_regs;
	required_device<mc68901_device> m_mfp;
	required_device<mc68681_device> m_keyboard_duart;
	required_ioport_array<3> m_panel;
	required_ioport m_host_keys;
	required_ioport m_host_shift;
	required_ioport m_host_hold;
	required_ioport m_export;
	output_finder<4> m_shift_lamps;
	output_finder<> m_second_screen_label;
	required_device<mc68681_device> m_serial_duart;

	uint8_t m_vme_regs[0x200]{};
	uint8_t m_memc_regs[0x200]{};
	uint8_t m_status_regs[0x10]{};
	uint8_t m_site_byte = 0;
	uint16_t m_lan_port_low = 0;
	emu_timer *m_heartbeat = nullptr;
	emu_timer *m_field_timer = nullptr;
	emu_timer *m_capture_timer = nullptr;
	emu_timer *m_key_timer = nullptr;
	emu_timer *m_mouse_timer = nullptr;
	emu_timer *m_tablet_timer = nullptr;
	std::deque<uint8_t> m_tablet_queue;
	uint8_t m_tablet_byte = 0;
	int m_tablet_bit = -1;
	bool m_tablet_mode = false;
	enum { SHOW_COLOR_EDIT, SHOW_VIDEO, SHOW_KEY, SHOW_COUNT };
	int m_second_screen = SHOW_COLOR_EDIT;
	bool m_tablet_pen = false;
	bool m_export_menu_added = false;
	int m_tablet_buttons = 0;
	int m_tablet_wait = 0;
	std::deque<uint8_t> m_mouse_queue;
	uint8_t m_mouse_byte = 0;
	int m_mouse_bit = -1;
	uint8_t m_mouse_last_buttons = 0;
	bool m_pointer_active = false;
	bool m_pointer_edit = false;
	int m_pointer_x = 0;
	int m_pointer_y = 0;
	int m_pointer_buttons = 0;
	int m_cursor_x = CURSOR_RIGHT;
	int m_cursor_y = CURSOR_BOTTOM;
	int m_cursor_seen_x = -1;
	int m_cursor_seen_y = -1;
	int m_cursor_settle = 0;
	int m_cursor_idle = 0;
	int m_cursor_home = 0;
	bool m_host_focus = false;
	std::deque<uint8_t> m_paste_queue;
	bool m_paste_held = false;
	int m_paste_wait = 0;
	std::deque<uint8_t> m_key_queue;
	uint8_t m_key_byte = 0;
	unsigned m_export_count = 0;
	bool m_export_held = false;
	bool m_lower_field = false;
#if !defined(__EMSCRIPTEN__)
	std::unique_ptr<field_capture> m_capture;
	uint32_t *m_capture_frame = nullptr; // set between a frame's two fields
#endif
	uint32_t m_panel_last[3]{};
	bitmap_rgb32 m_video_input; // what the Video Input board sees
	int m_repeat_key = -1; // index into PANEL_KEYS
	int m_repeat_wait = 0;
	int m_shift = -1;
	int m_held_shift = -1;
	int m_key_bit = -1;
	int m_irq_level = 0;
	bool m_bim_input[4]{};
	uint8_t m_bim_control[4]{};
	uint8_t m_bim_vector[4] = { 0x0f, 0x0f, 0x0f, 0x0f };
	bool m_keyboard_irq = false;
	bool m_mfp_irq = false;
	std::string m_console[4];
};

template <unsigned Size>
uint8_t maxine_state::stub_r(char const *name, uint8_t const (&regs)[Size], offs_t offset)
{
	uint8_t const data = regs[offset % Size];
	if (!machine().side_effects_disabled())
		LOGMASKED(LOG_REGS, "%s: %s read %03x = %02x\n", machine().describe_context(), name, offset, data);
	return data;
}

template <unsigned Size>
void maxine_state::stub_w(char const *name, uint8_t (&regs)[Size], offs_t offset, uint8_t data)
{
	LOGMASKED(LOG_REGS, "%s: %s write %03x = %02x\n", machine().describe_context(), name, offset, data);
	regs[offset % Size] = data;
}

TMS340X0_SCANLINE_RGB32_CB_MEMBER(maxine_state::prompt_scanline)
{
}

// Bring-up aid: where the CPU is once a second
TIMER_CALLBACK_MEMBER(maxine_state::heartbeat)
{
	uint32_t const sp = m_maincpu->state_int(M68K_A7);
	std::string stack;
	address_space &space = m_maincpu->space(AS_PROGRAM);
	for (int i = 0; i < 16; i++)
		stack += util::string_format(" %08x", space.read_dword_unaligned(sp + i * 4));
	LOGMASKED(LOG_HEARTBEAT, "heartbeat pc=%08x sr=%04x sp=%08x:%s\n", m_maincpu->pc(), m_maincpu->state_int(M68K_SR), sp, stack);
}

// Two 16-bit writes, low word first
void maxine_state::lan_port_w(offs_t offset, uint16_t data)
{
	if (offset == 0)
		m_lan_port_low = data;
	else
		m_lan->port((uint32_t(data) << 16) | m_lan_port_low);
}

static constexpr uint32_t swap16_long(uint32_t value) { return (value << 16) | (value >> 16); }

// The 82596's view of big-endian memory: 16-bit fields as they are, 32-bit pointers low
// word first, which is a little-endian chip with the words of each long swapped. Frame
// data doesn't go through this on the real board, so that still needs sorting out.
uint32_t maxine_state::lan_r(offs_t offset, uint32_t mem_mask)
{
	return swap16_long(m_dram[offset]);
}

void maxine_state::lan_w(offs_t offset, uint32_t data, uint32_t mem_mask)
{
	m_dram[offset] = (m_dram[offset] & ~swap16_long(mem_mask)) | (swap16_long(data) & swap16_long(mem_mask));
}

// Motorola 68153 BIM: four level-sensitive inputs, each with a control register (bit 4
// enable, bit 3 clear the enable on acknowledge, low bits the VME IRQ) and a vector. The MAME
// model never drops a channel's pending state after an acknowledge, so a channel that has
// fired once answers every later acknowledge at that level, which is why it isn't used here.
uint8_t maxine_state::bim_r(offs_t offset)
{
	return offset < 4 ? m_bim_control[offset] : m_bim_vector[offset & 3];
}

void maxine_state::bim_w(offs_t offset, uint8_t data)
{
	if (offset < 4)
		m_bim_control[offset] = data & 0x7f;
	else
		m_bim_vector[offset & 3] = data;
	update_irq(0);
}

int maxine_state::bim_channel_level(int channel) const
{
	if (!m_bim_input[channel] || !BIT(m_bim_control[channel], 4))
		return 0;
	int const irq = m_bim_control[channel] & 7;
	if (!irq || !BIT(m_vme_regs[0x6f], irq - 1))
		return 0;
	return BIT(get_u32be(&m_vme_regs[0x84]), (irq - 1) * 4, 3);
}

// VMEbus IRQ n reaches the CPU if enabled in the VMEchip2, at the level its map gives.
// The Andrea board's BIM is the only VME interrupter so far.
int maxine_state::vme_irq_level() const
{
	int level = 0;
	for (int channel = 0; channel < 4; channel++)
		level = std::max(level, bim_channel_level(channel));
	return level;
}

template <unsigned Channel>
void maxine_state::bim_input_w(int state)
{
	m_bim_input[Channel] = state != 0;
	update_irq(0);
}

int maxine_state::bim_acknowledge(int level)
{
	for (int channel = 0; channel < 4; channel++)
	{
		if (bim_channel_level(channel) == level)
		{
			if (BIT(m_bim_control[channel], 3))
				m_bim_control[channel] &= ~0x10;
			if (channel == 2)
				m_bim_input[2] = false; // the field interrupt is a latched pulse
			return m_bim_vector[channel];
		}
	}
	return -1;
}

void maxine_state::keyboard_irq_w(int state)
{
	m_keyboard_irq = state != 0;
	bim_input_w<3>(m_keyboard_irq || m_mfp_irq);
}

void maxine_state::mfp_irq_w(int state)
{
	m_mfp_irq = state != 0;
	bim_input_w<3>(m_keyboard_irq || m_mfp_irq);
}

// The 34010's 4-bit pixels hold two outputs, low nibble leftmost in each 16-bit word with 1024
// pixels to a row. The top three bits are the Prompts monitor and bit 0 is the overlay for Color
// Edit (the cursor, safe title and colour chip). The 34010 runs its display timing from
// external sync (VTOTAL is left at $ffff), so this reads VRAM straight. The palette is a guess.
// MAME's TMS34010 ignores PMASK, and the firmware relies on it to keep the two outputs apart:
// $1111 while drawing Prompts, $eeee while drawing the overlay.
void maxine_state::vram_w(offs_t offset, uint16_t data, uint16_t mem_mask)
{
	static constexpr offs_t REG_PMASK = 0x16;

	// Only the 34010's own pixels are masked, not host port writes or its code and data above
	// the display area. Plane masking only applies to pixel operations on the real chip.
	if (offset < PROMPT_ROWS * VRAM_ROW_WORDS && m_prompt->executing())
		mem_mask &= ~m_prompt->io_register_r(REG_PMASK);
	COMBINE_DATA(&m_vram[offset]);
}

uint32_t maxine_state::prompt_update(screen_device &screen, bitmap_rgb32 &bitmap, rectangle const &cliprect)
{
	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		uint16_t const *const row = &m_vram[y * VRAM_ROW_WORDS];
		uint32_t *const dest = &bitmap.pix(y);
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			unsigned const shade = (BIT(row[x / 4], (x & 3) * 4 + 1, 3) * 255) / 7;
			dest[x] = (shade << 16) | (shade << 8) | shade;
		}
	}
	return 0;
}

// Color Edit is the Video channel with the 34010 overlay on top, and is what an operator
// composes on. Video and Key themselves are clean. The window's second screen can show either
// in place of Color Edit. Color Edit doesn't fade, because Fade wants the next page composed
// while the outputs are faded out.
uint32_t maxine_state::edit_update(screen_device &screen, bitmap_rgb32 &bitmap, rectangle const &cliprect)
{
	if (m_second_screen == SHOW_KEY)
	{
		m_fb->render_key(bitmap, cliprect);
		return 0;
	}

	m_fb->render_video(bitmap, cliprect, m_second_screen == SHOW_VIDEO);
	if (m_second_screen == SHOW_VIDEO)
		return 0;

	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		int const row = y + OVERLAY_ROW_OFFSET;
		if (row < 0)
			continue;
		uint16_t const *const src = &m_vram[row * VRAM_ROW_WORDS];
		uint32_t *const dest = &bitmap.pix(y);
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			int const column = x + OVERLAY_COLUMN_OFFSET;
			if (BIT(src[column / 4], (column & 3) * 4))
				dest[x] = 0xffffff;
		}
	}
	return 0;
}

void maxine_state::poll_host()
{
	if (s_quit_requested)
		machine().schedule_exit();

#if !defined(__EMSCRIPTEN__)
	int const command = s_capture_command.exchange(0);
	if (command)
		end_capture();
	if (command > 0)
		m_capture = std::make_unique<field_capture>(command);

	std::optional<std::string> video_input;
	{
		std::lock_guard const lock(s_video_input_lock);
		video_input.swap(s_video_input_path);
	}
	if (video_input)
		load_video_input(*video_input);
#else
	if (s_page_video_input)
	{
		load_video_input(*s_page_video_input);
		s_page_video_input.reset();
	}
#endif

	// The board writes what it sees into the frame buffer for as long as the firmware lets it
	if (m_fb->video_input_live())
		m_fb->write_video_input(m_video_input, BIT(m_video_input_regs[4], 16));
}

// The picture fills the 4:3 frame without being cropped, centred on black. NTSC pixels are 0.9 as wide as tall,
// so a picture with square pixels is narrowed, while one that's already an NTSC frame, 720 or 704 wide and 486
// or 480 tall, keeps its pixels as they are. Each pixel averages the part of the picture it covers.
void maxine_state::set_video_input(uint8_t const *rgba, int width, int height)
{
	static constexpr double PIXEL_WIDTH = 0.9;
	static constexpr double EDGE = 1e-6; // so rounding doesn't take in a neighbour when pixels line up
	int const out_width = m_video_input.width();
	int const out_height = m_video_input.height();

	m_video_input.fill(0);
	if (width <= 0 || height <= 0)
		return;
	bool const ntsc = (width == 720 || width == 704) && (height == 486 || height == 480);
	double const source_pixel = ntsc ? PIXEL_WIDTH : 1.0; // in square units, like frame_width
	double const frame_width = out_width * PIXEL_WIDTH;
	double const scale = std::min(frame_width / (width * source_pixel), double(out_height) / height);
	double const left = (frame_width - width * source_pixel * scale) / 2;
	double const top = (out_height - height * scale) / 2;

	for (int y = 0; y < out_height; y++)
	{
		double const v0 = (y - top) / scale, v1 = (y + 1 - top) / scale;
		if (v1 <= 0 || v0 >= height)
			continue;
		int const row0 = std::max(0, int(v0 + EDGE)), row1 = std::clamp(int(std::ceil(v1 - EDGE)), row0 + 1, height);
		for (int x = 0; x < out_width; x++)
		{
			double const u0 = (x * PIXEL_WIDTH - left) / scale / source_pixel;
			double const u1 = ((x + 1) * PIXEL_WIDTH - left) / scale / source_pixel;
			if (u1 <= 0 || u0 >= width)
				continue;
			int const col0 = std::max(0, int(u0 + EDGE)), col1 = std::clamp(int(std::ceil(u1 - EDGE)), col0 + 1, width);
			unsigned sum[3]{}, count = 0;
			for (int row = row0; row < row1; row++)
				for (int col = col0; col < col1; col++)
				{
					uint8_t const *const p = &rgba[(size_t(row) * width + col) * 4];
					for (int c = 0; c < 3; c++)
						sum[c] += p[c] * p[3] / 255; // on black
					count++;
				}
			m_video_input.pix(y, x) = (sum[0] / count) << 16 | (sum[1] / count) << 8 | sum[2] / count;
		}
	}
}

void maxine_state::load_video_input(std::string const &path)
{
	if (path.empty())
	{
		set_video_input(nullptr, 0, 0);
		logerror("Video input: none\n");
		return;
	}
	util::core_file::ptr file;
	bitmap_argb32 picture;
	if (util::core_file::open(path, OPEN_FLAG_READ, file) || util::png_read_bitmap(*file, picture))
	{
		logerror("Video input: cannot read %s\n", path);
		return;
	}
	std::vector<uint8_t> rgba(size_t(picture.width()) * picture.height() * 4);
	for (int y = 0; y < picture.height(); y++)
		for (int x = 0; x < picture.width(); x++)
		{
			rgb_t const pixel = picture.pix(y, x);
			uint8_t *const p = &rgba[(size_t(y) * picture.width() + x) * 4];
			p[0] = pixel.r();
			p[1] = pixel.g();
			p[2] = pixel.b();
			p[3] = pixel.a();
		}
	set_video_input(rgba.data(), picture.width(), picture.height());
	logerror("Video input: %dx%d picture\n", picture.width(), picture.height());
}

#if !defined(__EMSCRIPTEN__)

// A frame with only its first field is dropped, so the app gets whole frames
void maxine_state::end_capture()
{
	m_capture_frame = nullptr;
	m_capture.reset();
}

// Each field is taken at its own moment, as a raster would show it, so motion is really interlaced. A
// 486-line frame's first line belongs to the later field, so a frame starts on the odd rows.
TIMER_CALLBACK_MEMBER(maxine_state::capture_field)
{
	if (!m_capture)
		return;
	if (m_capture->failed())
	{
		end_capture();
		return;
	}

	if (m_lower_field && !m_capture_frame)
		m_capture_frame = m_capture->next_frame();
	if (!m_capture_frame)
		return;

	m_fb->render_field(m_capture_frame, m_lower_field ? 1 : 0, field_capture::WIDTH, field_capture::HEIGHT);
	if (!m_lower_field)
	{
		m_capture->submit_frame();
		m_capture_frame = nullptr;
	}
}

#endif // !__EMSCRIPTEN__

// The field interrupt also tells the firmware the video standard: it counts these for a
// while, and fewer than 58 a second means 625 lines. Video board timing isn't modelled.
TIMER_CALLBACK_MEMBER(maxine_state::field_tick)
{
	poll_host();
#if defined(__EMSCRIPTEN__)
	s_page_fields++;
#endif

	bim_input_w<2>(ASSERT_LINE);

	// Parity is ours, because nothing the firmware does here tells the fields apart. Picture starts
	// some lines after this interrupt, by when the firmware's handler has run.
	m_lower_field = !m_lower_field;
#if !defined(__EMSCRIPTEN__)
	if (m_capture)
		m_capture_timer->adjust(attotime::from_ticks(FIRST_ACTIVE_LINE * RASTER_LINE_CLOCKS, 13'500'000));
#endif

#if defined(__APPLE__)
	if (!m_export_menu_added)
	{
		add_export_menu();
		m_export_menu_added = true;
	}
	if (s_export_requested != export_request::NONE)
	{
		bool const square = s_export_requested == export_request::SQUARE;
		s_export_requested = export_request::NONE;
		std::string const folder = choose_export_folder();
		if (!folder.empty())
			export_outputs(square, folder);
	}
#endif

	bool const export_pressed = m_export->read() != 0;
	if (export_pressed && !m_export_held)
		export_outputs(m_host_shift->read() != 0);
	m_export_held = export_pressed;

	uint32_t const held = m_host_hold->read();
	m_held_shift = held ? std::countr_zero(held) : -1;

	for (int port = 0; port < 3; port++)
	{
		uint32_t const keys = m_panel[port]->read();
		for (unsigned i = 0; i < 32; i++)
			if (BIT(keys & ~m_panel_last[port], i) && unsigned(port) * 32 + i < std::size(PANEL_KEYS))
			{
				uint16_t const code = PANEL_KEYS[port * 32 + i];
				panel_key(code);
				if (code >= 0x8c && code <= 0x8f)
				{
					m_repeat_key = port * 32 + i;
					m_repeat_wait = REPEAT_DELAY_FIELDS;
				}
			}
		m_panel_last[port] = keys;
	}

	// The last cursor key pressed repeats until it's let go. Going through panel_key means a shift held
	// or latched applies to each repeat.
	if (m_repeat_key >= 0)
	{
		if (!BIT(m_panel_last[m_repeat_key / 32], m_repeat_key % 32))
			m_repeat_key = -1;
		else if (--m_repeat_wait == 0)
		{
			panel_key(PANEL_KEYS[m_repeat_key]);
			m_repeat_wait = REPEAT_FIELDS;
		}
	}

	int const shift = active_shift();
	for (int i = 0; i < 3; i++)
		m_shift_lamps[i] = (shift == i) ? 1 : 0;
	m_shift_lamps[3] = m_tablet_mode ? 1 : 0;
	m_second_screen_label = m_second_screen;

#if defined(__EMSCRIPTEN__)
	if (!s_page_paste.empty())
	{
		paste_text(s_page_paste);
		s_page_paste.clear();
	}
#else
#if defined(_WIN32)
	bool const paste_pressed = m_host_keys->read() == 6; // Right Alt and V, because Windows keeps Win+V
#else
	bool const paste_pressed = m_host_keys->read() == 3; // Command and V
#endif
	if (paste_pressed && !m_paste_held)
		paste_text(osd_get_clipboard_text());
	m_paste_held = paste_pressed;
#endif
	if (!m_paste_queue.empty() && ++m_paste_wait >= PASTE_FIELDS)
	{
		m_paste_wait = 0;
		key_w(m_paste_queue.front());
		m_paste_queue.pop_front();
	}

	// Moves are lost while the app is in the background, so start again from a known position
	bool const focus = SDL_GetKeyboardFocus() != nullptr;
	if (focus && !m_host_focus)
		m_cursor_home = CURSOR_HOME_MOVES;
	m_host_focus = focus;

	update_mouse();
}

// One byte per key press at 9600 8E1 into DUART channel A. The real keyboard is an 8052 on
// an RS-485 pair. The codes above $7f are the MAXINE function keys; see docs/hardware-map.md.
// NTSC pixels are 0.9 as wide as tall, so each pixel here covers 10/9 of one there. Only the width
// changes, so the lines stay as they are.
static void square_pixels(bitmap_rgb32 const &src, bitmap_rgb32 &dest)
{
	for (int y = 0; y < src.height(); y++)
		for (int x = 0; x < dest.width(); x++)
		{
			unsigned sum[3]{};
			for (int part = 0; part < 10; part++)
			{
				uint32_t const pixel = src.pix(y, (x * 10 + part) / 9);
				for (int c = 0; c < 3; c++)
					sum[c] += BIT(pixel, c * 8, 8);
			}
			dest.pix(y, x) = (sum[2] / 10) << 16 | (sum[1] / 10) << 8 | sum[0] / 10;
		}
}

// Takes the middle of a picture, without resampling it again
static void crop_centre(bitmap_rgb32 const &src, bitmap_rgb32 &dest)
{
	int const left = (src.width() - dest.width()) / 2;
	int const top = (src.height() - dest.height()) / 2;
	for (int y = 0; y < dest.height(); y++)
		for (int x = 0; x < dest.width(); x++)
			dest.pix(y, x) = src.pix(y + top, x + left);
}

// Saves the clean Video and Key outputs as a matching pair: to the snapshot folder without a folder given,
// and either at 720x486 or as 640x480 square pixels, which is 648x486 less 4 columns and 3 lines each side.
// With ask, MAXINE! Studio then moves the pair to a folder it asks for, which works the same on every system.
void maxine_state::export_outputs(bool square, std::string const &folder, bool ask)
{
	bitmap_rgb32 video(720, 486), key(720, 486);
	m_fb->render_video(video, video.cliprect());
	m_fb->render_key(key, key.cliprect());

	std::string const suffix = square ? "-640x480.png" : ".png";
	auto const save = [&] (bitmap_rgb32 const &video_out, bitmap_rgb32 const &key_out)
	{
		if (folder.empty())
		{
			std::string const number = util::string_format("%04u", m_export_count++);
			if (!write_snapshot("maxine/video-" + number + suffix, video_out) || !write_snapshot("maxine/key-" + number + suffix, key_out))
				return;
			if (ask)
			{
#if defined(_WIN32)
				AllowSetForegroundWindow(ASFW_ANY); // or the dialog can open behind this window
#endif
				logerror("MAXINE_EXPORT %s%s\n", number, suffix);
			}
			else
				logerror("Saved video-%s%s and key-%s%s in snap/maxine\n", number, suffix, number, suffix);
			return;
		}

		// The next number free for both, so nothing in the folder gets replaced
		std::filesystem::path const base(folder);
		unsigned count = 0;
		std::string number;
		do
			number = util::string_format("-%04u", count++);
		while (std::filesystem::exists(base / ("video" + number + suffix)) || std::filesystem::exists(base / ("key" + number + suffix)));

		write_file((base / ("video" + number + suffix)).string(), video_out);
		write_file((base / ("key" + number + suffix)).string(), key_out);
	};

	if (!square)
	{
		save(video, key);
		return;
	}

	bitmap_rgb32 narrowed(648, 486), video_cropped(640, 480), key_cropped(640, 480);
	square_pixels(video, narrowed);
	crop_centre(narrowed, video_cropped);
	square_pixels(key, narrowed);
	crop_centre(narrowed, key_cropped);
	save(video_cropped, key_cropped);
}

bool maxine_state::write_snapshot(std::string filename, bitmap_rgb32 const &bitmap)
{
	strreplace(filename, "/", PATH_SEPARATOR); // on Windows, MAME only makes the folder from its own separator
	emu_file file(machine().options().snapshot_directory(), OPEN_FLAG_WRITE | OPEN_FLAG_CREATE | OPEN_FLAG_CREATE_PATHS);
	if (file.open(filename))
	{
		logerror("cannot write %s\n", filename);
		return false;
	}
	util::png_info info;
	util::png_write_bitmap(file, &info, bitmap, 0, nullptr);
	return true;
}

void maxine_state::write_file(std::string const &path, bitmap_rgb32 const &bitmap)
{
	util::core_file::ptr file;
	if (util::core_file::open(path, OPEN_FLAG_WRITE | OPEN_FLAG_CREATE, file))
	{
		logerror("cannot write %s\n", path);
		return;
	}
	util::png_info info;
	util::png_write_bitmap(*file, &info, bitmap, 0, nullptr);
}

void maxine_state::host_key(uint8_t data)
{
	if (BIT(m_host_keys->read(), 0)) // Command belongs to the host
		return;
#if defined(_WIN32)
	if (BIT(m_host_keys->read(), 2) && (data == 'v' || data == 'V')) // only V, so AltGr still types
		return;
#endif

	switch (data)
	{
	case 0x0d: data = 0xce; break; // Return is NEW LINE
	case 0x1b: data = 0xfe; break; // Esc
	case 0x09: data = m_host_shift->read() ? 0xe6 : 0xe5; break; // Tab
	case 0x08: data = 0x5e; break; // Backspace
	case 0x0a: case 0x7f: return; // Insert and Delete, which the input ports handle
	}
	key_w(data);
}

void maxine_state::key_w(uint8_t data)
{
	if (m_key_queue.size() < 64)
		m_key_queue.push_back(data);
	if (m_key_bit < 0 && !m_key_queue.empty())
		m_key_timer->adjust(attotime::zero);
}

// Pasted text is typed in at the pace of field_tick. There's no key for anything else, and '^'
// would be Backspace.
void maxine_state::paste_text(std::string const &text)
{
	for (size_t i = 0; i < text.size(); i++)
	{
		uint8_t const c = text[i];
		if (c == '\n' && i && text[i - 1] == '\r')
			continue;
		if (c == '\r' || c == '\n')
			m_paste_queue.push_back(0xce);
		else if (c >= 0x20 && c < 0x7f && c != '^')
			m_paste_queue.push_back(c);
	}
}

// The shift keys are held on the real keyboard and change what a cursor key sends. On the panel a
// click latches one until a second click clears it or another takes over. The host's keys for them
// are held, as on the real one, and win over a latched key. The host's Shift then gives the S-SHIFT
// codes, which move further.
int maxine_state::active_shift() const
{
	return (m_held_shift >= 0) ? m_held_shift : m_shift;
}

void maxine_state::panel_key(uint16_t code)
{
	static constexpr uint8_t SHIFT_BASE[] = { 0x88, 0x84, 0x80 }; // CHAR, PAGE, ROW

	if (code == 0x104 || code == 0x105) // the export buttons
	{
		export_outputs(code == 0x105, std::string(), true);
	}
	else if (code == 0x106)
	{
		m_second_screen = (m_second_screen + 1) % SHOW_COUNT;
	}
	else if (code == 0x103)
	{
		m_tablet_mode = !m_tablet_mode;
		m_cursor_home = CURSOR_HOME_MOVES;
		m_tablet_pen = false;
	}
	else if (code >= 0x100)
	{
		int const shift = code - 0x100;
		m_shift = (m_shift == shift) ? -1 : shift;
	}
	else if (code >= 0x8c && code <= 0x8f && active_shift() >= 0)
	{
		key_w(SHIFT_BASE[active_shift()] + (m_host_shift->read() ? 0x10 : 0) + (code - 0x8c));
	}
	else
		key_w(code);
}

// From the layout script: x << 16 | buttons << 12 | y in Prompts pixels, with bit 30 set and raster
// pixels instead over Color Edit, or all ones elsewhere. Over Prompts, or either screen with the
// tablet, the host's pointer gives way to the firmware's. Buttons: bit 0 left, bit 1 right.
void maxine_state::pointer_w(uint32_t data)
{
	m_pointer_edit = BIT(data, 30);
	bool const active = data != 0xffffffff && (m_tablet_mode || !m_pointer_edit);
	if (active != m_pointer_active)
#if defined(__EMSCRIPTEN__)
		active ? SDL_HideCursor() : SDL_ShowCursor();
#else
		SDL_ShowCursor(active ? 0 : 1);
#endif
	if (active && !m_pointer_active)
		m_cursor_home = CURSOR_HOME_MOVES;

	m_pointer_active = active;
	m_pointer_buttons = 0;
	if (m_pointer_active)
	{
		m_pointer_x = BIT(data, 16, 14);
		m_pointer_y = data & 0xfff;
		m_pointer_buttons = BIT(data, 12, 2);
	}
}

// The driver only knows the firmware's cursor by counting what it sent, which fails when a program
// restarts it. The 34010 mailbox has the last blit's position, of any kind, then the one before
// with its size. Once moves have stopped, a cursor blit followed by the clock's is where the cursor
// really is. Anything else might be a menu redraw after the cursor had moved on.
void maxine_state::update_cursor_position()
{
	static constexpr unsigned LAST_BLIT = 0x24c10; // word offsets
	static constexpr unsigned PREVIOUS_BLIT = 0x24c20;

	uint16_t const *const last = &m_vram[LAST_BLIT];
	uint16_t const *const previous = &m_vram[PREVIOUS_BLIT];
	if (previous[1] != 0x2804 || previous[16] > 8 || previous[17] != 15)
	{
		m_cursor_seen_x = -1;
		return;
	}

	int const x = previous[6], y = previous[7];
	if (m_cursor_idle < CURSOR_IDLE_FIELDS || last[1] >= CURSOR_TOP || (x == m_cursor_seen_x && y == m_cursor_seen_y))
		return;
	m_cursor_x = m_cursor_seen_x = x;
	m_cursor_y = m_cursor_seen_y = y;
}

// A real tablet streams while the pen is near it, and Logo Compose only follows a stream. It maps a
// window of the tablet, with Y up, to the crosshair on Color Edit or the arrow on Prompts, so the
// pointer has to be over the one in use. It also takes every line with a button down as a new press,
// so a click is one line, and the stream waits for PSOS to clear its frame flag before going on.
void maxine_state::update_tablet()
{
	if (m_tablet_wait)
	{
		bool const pending = m_maincpu->space(AS_PROGRAM).read_dword(TABLET_FRAME_FLAG) != 0;
		if (--m_tablet_wait > TABLET_CLICK_FIELDS - 3 || (m_tablet_wait && pending))
			return;
		m_tablet_wait = 0;
	}

	int const buttons = m_pointer_active ? m_pointer_buttons : 0;
	int const pressed = buttons & ~m_tablet_buttons;
	m_tablet_buttons = buttons;

	if (m_pointer_active)
	{
		if (m_pointer_edit)
			tablet_frame(std::clamp(int((m_pointer_x - TABLET_EDIT_X_ORIGIN) * TABLET_EDIT_X_SCALE), 0, TABLET_EDIT_X_MAX),
					std::clamp(int((TABLET_EDIT_Y_ORIGIN - m_pointer_y) * TABLET_EDIT_Y_SCALE), TABLET_EDIT_Y_MIN, TABLET_EDIT_Y_MAX), pressed);
		else
			tablet_frame((m_pointer_x - PROMPT_LEFT + 7) * TABLET_MENU_X_SCALE, (TABLET_MENU_Y_ORIGIN - (m_pointer_y - PROMPT_TOP)) * TABLET_MENU_Y_SCALE, pressed);
		m_tablet_pen = true;
		if (pressed)
			m_tablet_wait = TABLET_CLICK_FIELDS;
	}
	else if (m_tablet_pen)
	{
		tablet_frame(0, 0, 99);
		m_tablet_pen = false;
	}
}

void maxine_state::update_mouse()
{
	if (m_tablet_mode)
	{
		update_tablet();
		return;
	}

	m_cursor_idle++;
	update_cursor_position();

	if (m_cursor_settle)
	{
		m_cursor_settle--;
		return;
	}
	if (!m_mouse_queue.empty())
		return;

	// Pushing the cursor into its top left stop puts it at a known position
	if (m_pointer_active && m_cursor_home)
	{
		mouse_move(-127, -127, m_mouse_last_buttons);
		m_cursor_idle = 0;
		if (--m_cursor_home == 0)
		{
			m_cursor_x = CURSOR_LEFT;
			m_cursor_y = CURSOR_TOP;
		}
		return;
	}

	int const x = std::clamp(m_pointer_x + CURSOR_TIP_X, CURSOR_LEFT, CURSOR_RIGHT);
	int const y = std::clamp(m_pointer_y + CURSOR_TIP_Y, CURSOR_TOP, CURSOR_BOTTOM);
	int const dx = m_pointer_active ? std::clamp(x - m_cursor_x, -120, 120) : 0;
	int const dy = m_pointer_active ? std::clamp(y - m_cursor_y, -120, 120) : 0;
	int const buttons = (dx || dy) ? m_mouse_last_buttons : m_pointer_buttons; // click on arrival
	if (dx || dy || buttons != m_mouse_last_buttons)
	{
		mouse_move(dx, dy, buttons);
		m_cursor_x += dx;
		m_cursor_y += dy;
		m_mouse_last_buttons = buttons;
		m_cursor_settle = 2;
		m_cursor_idle = 0;
	}
}

// Microsoft serial mouse on DUART channel B: 1200 baud 7N1, three bytes per report, with bit 6
// marking the first. buttons: bit 0 left, bit 1 right.
void maxine_state::mouse_move(int dx, int dy, int buttons)
{
	if (m_mouse_queue.size() > 30)
		return;
	m_mouse_queue.push_back(0x40 | (BIT(buttons, 0) << 5) | (BIT(buttons, 1) << 4) | (BIT(dy, 6, 2) << 2) | BIT(dx, 6, 2));
	m_mouse_queue.push_back(dx & 0x3f);
	m_mouse_queue.push_back(dy & 0x3f);
	if (m_mouse_bit < 0)
		m_mouse_timer->adjust(attotime::zero);
}

TIMER_CALLBACK_MEMBER(maxine_state::mouse_bit)
{
	if (m_mouse_bit < 0)
	{
		if (m_mouse_queue.empty())
			return;
		m_mouse_byte = m_mouse_queue.front();
		m_mouse_queue.pop_front();
		m_mouse_bit = 0;
		m_keyboard_duart->rx_b_w(0); // start
	}
	else if (m_mouse_bit < 7)
		m_keyboard_duart->rx_b_w(BIT(m_mouse_byte, m_mouse_bit++));
	else
	{
		m_keyboard_duart->rx_b_w(1); // stop
		m_mouse_bit = -1;
	}
	m_mouse_timer->adjust(attotime::from_hz(1200));
}

// The tablet port is channel A of the serial DUART, set from NVRAM $218: baud, then data bits and
// parity (1 odd, 2 none) a nibble each. Lines are the 18 characters of a WACOM SD510C's ASCII
// format, the only part of the tablet the firmware listens to.
void maxine_state::tablet_frame(int x, int y, int buttons)
{
	if (m_tablet_queue.size() > 36)
		return;
	std::string const line = util::string_format("#,%05d,%05d,%02d\r\n", std::max(x, 0), std::max(y, 0), buttons);
	m_tablet_queue.insert(m_tablet_queue.end(), line.begin(), line.end());
	if (m_tablet_bit < 0)
		m_tablet_timer->adjust(attotime::zero);
}

TIMER_CALLBACK_MEMBER(maxine_state::tablet_bit)
{
	address_space &space = m_maincpu->space(AS_PROGRAM);
	attotime const bit_time = attotime::from_hz(space.read_word(0xfffc0218));
	bool const parity = (space.read_byte(0xfffc021a) & 15) != 2;

	if (m_tablet_bit < 0)
	{
		if (m_tablet_queue.empty())
			return;
		m_tablet_byte = m_tablet_queue.front();
		m_tablet_queue.pop_front();
		m_tablet_bit = 0;
		m_serial_duart->rx_a_w(0); // start
	}
	else if (m_tablet_bit < 8)
		m_serial_duart->rx_a_w(BIT(m_tablet_byte, m_tablet_bit++));
	else if (m_tablet_bit == 8 && parity)
	{
		m_serial_duart->rx_a_w(~std::popcount(m_tablet_byte) & 1); // odd parity
		m_tablet_bit++;
	}
	else
	{
		m_serial_duart->rx_a_w(1); // stop
		m_tablet_bit = -1;
	}
	m_tablet_timer->adjust(bit_time);
}

TIMER_CALLBACK_MEMBER(maxine_state::key_bit)
{
	attotime const bit_time = attotime::from_hz(9600);

	if (m_key_bit < 0)
	{
		if (m_key_queue.empty())
			return;
		m_key_byte = m_key_queue.front();
		m_key_queue.pop_front();
		m_key_bit = 0;
		m_keyboard_duart->rx_a_w(0); // start
	}
	else if (m_key_bit < 8)
		m_keyboard_duart->rx_a_w(BIT(m_key_byte, m_key_bit++));
	else if (m_key_bit == 8)
	{
		m_keyboard_duart->rx_a_w(std::popcount(m_key_byte) & 1); // even parity
		m_key_bit++;
	}
	else
	{
		m_keyboard_duart->rx_a_w(1); // stop
		m_key_bit = -1;
	}
	m_key_timer->adjust(bit_time);
}

void maxine_state::update_irq(int state)
{
	int level = m_mcc->level();
	int const vme_level = vme_irq_level();
	if (vme_level > level)
		level = vme_level;
	if (level != m_irq_level)
	{
		if (m_irq_level)
			m_maincpu->set_input_line(M68K_IRQ_1 + m_irq_level - 1, CLEAR_LINE);
		if (level)
			m_maincpu->set_input_line(M68K_IRQ_1 + level - 1, ASSERT_LINE);
		m_irq_level = level;
	}
}

// Offsets are the low nibble of the acknowledge address, 1 + 2 * level.
uint8_t maxine_state::iack_r(offs_t offset)
{
	int const level = offset >> 1;
	int const vector = m_mcc->acknowledge(level);
	if (vector == mcchip_device::ACK_SCC)
		return m_scc[0]->m1_r();
	int const bim_vector = vector < 0 ? bim_acknowledge(level) : -1;
	update_irq(0);
	if (bim_vector >= 0)
		return bim_vector;
	return vector >= 0 ? vector : 0x18; // spurious
}

void maxine_state::cpu_space_map(address_map &map)
{
	map(0xfffffff0, 0xffffffff).r(FUNC(maxine_state::iack_r));
}

uint8_t maxine_state::scc_r(int chip, offs_t offset)
{
	switch (offset & 7)
	{
	case 1: return m_scc[chip]->cb_r(0);
	case 3: return m_scc[chip]->db_r(0);
	case 5: return m_scc[chip]->ca_r(0);
	case 7: return m_scc[chip]->da_r(0);
	default: return 0xff;
	}
}

// Copies each serial port to the log a line at a time
void maxine_state::console_w(int port, uint8_t data)
{
	std::string &line = m_console[port];
	if (data == '\n' || data == '\r')
	{
		if (!line.empty())
			LOGMASKED(LOG_CONSOLE, "port %d: %s\n", port + 1, line);
		line.clear();
	}
	else if (data >= 0x20 && data < 0x7f)
		line.push_back(char(data));
	else
		line += util::string_format("<%02x>", data);
}

void maxine_state::scc_w(int chip, offs_t offset, uint8_t data)
{
	switch (offset & 7)
	{
	case 1: m_scc[chip]->cb_w(0, data); break;
	case 3: console_w(chip * 2 + 1, data); m_scc[chip]->db_w(0, data); break;
	case 5: m_scc[chip]->ca_w(0, data); break;
	case 7: console_w(chip * 2, data); m_scc[chip]->da_w(0, data); break;
	}
}

uint32_t maxine_state::dma_r(offs_t offset, uint32_t mem_mask)
{
	return m_maincpu->space(AS_PROGRAM).read_dword(offset, mem_mask);
}

void maxine_state::dma_w(offs_t offset, uint32_t data, uint32_t mem_mask)
{
	m_maincpu->space(AS_PROGRAM).write_dword(offset, data, mem_mask);
}

// Anything unclaimed ends the cycle with TEA, as the local bus timer does.
uint32_t maxine_state::unmapped_r(offs_t offset, uint32_t mem_mask)
{
	if (!machine().side_effects_disabled())
	{
		logerror("%s: unmapped read %08x & %08x\n", machine().describe_context(), offset << 2, mem_mask);
		m_maincpu->set_buserror_details(offset << 2, 1, m_maincpu->get_fc());
		m_maincpu->set_input_line(M68K_LINE_BUSERROR, ASSERT_LINE);
		m_maincpu->set_input_line(M68K_LINE_BUSERROR, CLEAR_LINE);
	}
	return 0xffffffff;
}

void maxine_state::unmapped_w(offs_t offset, uint32_t data, uint32_t mem_mask)
{
	logerror("%s: unmapped write %08x = %08x & %08x\n", machine().describe_context(), offset << 2, data, mem_mask);
	m_maincpu->set_buserror_details(offset << 2, 0, m_maincpu->get_fc());
	m_maincpu->set_input_line(M68K_LINE_BUSERROR, ASSERT_LINE);
	m_maincpu->set_input_line(M68K_LINE_BUSERROR, CLEAR_LINE);
}

void maxine_state::maxine_mem(address_map &map)
{
	map(0x00000000, 0xffffffff).rw(FUNC(maxine_state::unmapped_r), FUNC(maxine_state::unmapped_w));
	map(0x00000000, 0x003fffff).ram().share("dram");
	map(0x06000000, 0x09ffffff).ram().share("expram"); // Andrea board SIMMs, 64 MB
	// Frame buffer board on VSB, and the video board's registers. Apart from the line levels that the frame
	// buffer reads, they're plain memory until they're understood. $81202100 up (601 board) stays absent.
	map(0x81000000, 0x8107ffff).rw(m_fb, FUNC(chyron_fb_device::read), FUNC(chyron_fb_device::write));
	map(0x81200000, 0x81201fff).ram().share("line_levels");
	map(0x81202000, 0x812020ff).ram().share("line_level_control");
	map(0x81203000, 0x81205fff).ram();
	// Video Input board. HWINIT finds it by reading $81300018. Message Compose writes Gain to +0 and Black to
	// +4, as (state << 8 | percent * 255 / 100), Delay to +8, and Key Enable to bit 0 of +10. Only Key
	// Enable is used here. See write_video_input() in chyronfb.cpp for the picture.
	map(0x81300000, 0x8130001f).ram().share("video_input_regs");

	// Andrea interface board, local decode
	map(0x82100000, 0x82100007).rw(m_prompt, FUNC(tms34010_device::host_r), FUNC(tms34010_device::host_w));
	map(0x82100008, 0x82100009).lw16(NAME([this] (uint16_t data) {
		m_prompt->set_input_line(INPUT_LINE_RESET, BIT(data, 0) ? ASSERT_LINE : CLEAR_LINE); }));
	map(0x82101881, 0x82101881).lr8(NAME([] () { return uint8_t(0); })); // ARCNET ID switch, all off
	map(0x82101900, 0x8210190f).lrw8(
			NAME([this] (offs_t offset) { return stub_r("status", m_status_regs, offset); }),
			NAME([this] (offs_t offset, uint8_t data) { stub_w("status", m_status_regs, offset, data); }));
	map(0x82101981, 0x82101981).lrw8(
			NAME([this] () { return bitswap<8>(BIT(SITE_ID, m_site_byte ? 0 : 8, 8), 0, 1, 2, 3, 4, 5, 6, 7); }),
			NAME([this] (uint8_t data) { m_site_byte = BIT(data, 0); }));
	// Not on the board: lets test scripts inject input
	map(0x82104000, 0x82104000).w(FUNC(maxine_state::key_w));
	map(0x82104004, 0x82104007).lw32(NAME([this] (uint32_t data) { mouse_move(int8_t(data >> 24), int8_t(data >> 16), BIT(data, 0, 2)); }));
	map(0x82104008, 0x8210400b).lw32(NAME([this] (uint32_t data) { export_outputs(BIT(data, 0)); }));
	map(0x8210400c, 0x8210400f).lw32(NAME([this] (uint32_t data) { pointer_w(data); }));
	map(0x82104010, 0x82104010).lw8(NAME([this] (uint8_t data) { paste_text(std::string(1, char(data))); }));
	map(0x82104014, 0x82104017).lw32(NAME([this] (uint32_t data) { tablet_frame(BIT(data, 16, 12), BIT(data, 0, 12), BIT(data, 28, 4) == 15 ? 99 : BIT(data, 28, 4)); }));
	map(0x82102000, 0x8210200f).rw(FUNC(maxine_state::bim_r), FUNC(maxine_state::bim_w)).umask32(0x00ff00ff);
	map(0x82102800, 0x8210282f).rw(m_mfp, FUNC(mc68901_device::read), FUNC(mc68901_device::write)).umask32(0x00ff00ff);
	map(0x82103000, 0x8210301f).rw(m_keyboard_duart, FUNC(mc68681_device::read), FUNC(mc68681_device::write)).umask32(0x00ff00ff);
	map(0x82103800, 0x8210381f).rw(m_serial_duart, FUNC(mc68681_device::read), FUNC(mc68681_device::write)).umask32(0x00ff00ff);

	map(0xffe00000, 0xffefffff).ram(); // PSOS copies 512 KB here and needs it not to wrap, so more than the manual's 128 KB
	map(0xfff40000, 0xfff401ff).lrw8(
			NAME([this] (offs_t offset) { return stub_r("vmechip2", m_vme_regs, offset); }),
			NAME([this] (offs_t offset, uint8_t data) { stub_w("vmechip2", m_vme_regs, offset, data); update_irq(0); }));
	map(0xfff42000, 0xfff42fff).rw(m_mcc, FUNC(mcchip_device::read), FUNC(mcchip_device::write));
	map(0xfff43000, 0xfff431ff).lrw8(
			NAME([this] (offs_t offset) { return stub_r("memc040", m_memc_regs, offset); }),
			NAME([this] (offs_t offset, uint8_t data) { stub_w("memc040", m_memc_regs, offset, data); }));
	map(0xfff45000, 0xfff4500f).lrw8(
			NAME([this] (offs_t offset) { return scc_r(0, offset); }),
			NAME([this] (offs_t offset, uint8_t data) { scc_w(0, offset, data); }));
	map(0xfff45800, 0xfff4580f).lrw8(
			NAME([this] (offs_t offset) { return scc_r(1, offset); }),
			NAME([this] (offs_t offset, uint8_t data) { scc_w(1, offset, data); }));
	map(0xfff46000, 0xfff46003).w(FUNC(maxine_state::lan_port_w));
	map(0xfff46004, 0xfff46007).lw32(NAME([this] (uint32_t data) { m_lan->ca(1); }));
	map(0xfff47000, 0xfff470ff).lrw32(
			NAME([this] (offs_t offset, uint32_t mem_mask) {
				uint32_t const data = m_siop->read(offset, mem_mask);
				if (!machine().side_effects_disabled())
					LOGMASKED(LOG_SCSI, "%s: siop read %02x = %08x & %08x\n", machine().describe_context(), offset << 2, data, mem_mask);
				return data; }),
			NAME([this] (offs_t offset, uint32_t data, uint32_t mem_mask) {
				LOGMASKED(LOG_SCSI, "%s: siop write %02x = %08x & %08x\n", machine().describe_context(), offset << 2, data, mem_mask);
				m_siop->write(offset, data, mem_mask); }));
	map(0xfffc0000, 0xfffc1fff).mirror(0x0000e000).rw(m_nvram, FUNC(timekeeper_device::read), FUNC(timekeeper_device::write));
}

void maxine_state::lan_mem(address_map &map)
{
	map(0x00000000, 0x003fffff).rw(FUNC(maxine_state::lan_r), FUNC(maxine_state::lan_w));
}

void maxine_state::prompt_mem(address_map &map)
{
	map(0x00000000, 0x003fffff).mirror(0xffc00000).readonly().share("vram").w(FUNC(maxine_state::vram_w));
	map(0xc0000000, 0xc00001ff).rw(m_prompt, FUNC(tms34010_device::io_register_r), FUNC(tms34010_device::io_register_w));
}

// pHILE volume layout: see tools/phile.py.
static constexpr uint32_t PHILE_BLOCK = 1024;
static constexpr uint32_t PHILE_FLIST = 0x84;
static constexpr uint32_t PHILE_FD_SIZE = 128;
static constexpr uint32_t PHILE_ROOT_FN = 3;

bool maxine_state::read_block(harddisk_image_device &disk, uint32_t block, uint8_t *dest)
{
	return disk.read(block * 2, dest) && disk.read(block * 2 + 1, dest + 512);
}

bool maxine_state::load_file(harddisk_image_device &disk, std::initializer_list<const char *> path, uint32_t address)
{
	uint8_t block[PHILE_BLOCK];
	uint32_t fn = PHILE_ROOT_FN, size = 0, start = 0;

	auto descriptor = [&](uint32_t file)
	{
		if (!read_block(disk, PHILE_FLIST + file * PHILE_FD_SIZE / PHILE_BLOCK, block))
			return false;
		uint8_t const *const fd = block + file * PHILE_FD_SIZE % PHILE_BLOCK;
		size = get_u32be(fd + 0x10);
		start = get_u32be(fd + 0x14);
		return true;
	};

	if (!descriptor(fn))
		return false;

	for (char const *const name : path)
	{
		uint32_t const dir_size = size, dir_start = start;
		bool found = false;
		for (uint32_t offset = 0; !found && offset < dir_size; offset += 16)
		{
			if (!read_block(disk, dir_start + offset / PHILE_BLOCK, block))
				return false;
			uint8_t const *const entry = block + offset % PHILE_BLOCK;
			if (!strncmp(reinterpret_cast<char const *>(entry + 2), name, 14))
			{
				fn = get_u16be(entry);
				found = true;
			}
		}
		if (!found || !descriptor(fn))
			return false;
	}

	address_space &space = m_maincpu->space(AS_PROGRAM);
	for (uint32_t offset = 0; offset < size; offset += PHILE_BLOCK)
	{
		if (!read_block(disk, start + offset / PHILE_BLOCK, block))
			return false;
		for (uint32_t i = 0; i < PHILE_BLOCK && offset + i < size; i++)
			space.write_byte(address + offset + i, block[i]);
	}
	logerror("loaded %u bytes at %08x\n", size, address);
	return true;
}

// Does the boot PROM's job until there is a dump of it.
void maxine_state::boot_stub()
{
	auto *const disk = subdevice<harddisk_image_device>("scsi:0:harddisk:image");
	if (!disk || !disk->exists())
	{
		logerror("no disk image, nothing to boot\n");
		return;
	}

	static constexpr uint32_t PSOS_BASE = 0x3000;
	if (!load_file(*disk, { "SYSTEM", "PROGRAMS", "PSOS" }, PSOS_BASE))
	{
		logerror("cannot load /SYSTEM/PROGRAMS/PSOS\n");
		return;
	}

	// Until Setup has set one, the network matches emulator/net-up.sh: address, mask and gateway
	static constexpr uint8_t NETWORK[] = { 10, 37, 0, 2, 255, 255, 255, 0, 10, 37, 0, 1 };
	if (!m_nvram->read(0x77c))
	{
		static constexpr uint8_t ETHERNET[] = { 0x12, 0x34, 0x56 };
		for (int i = 0; i < 3; i++)
			m_nvram->write(0x779 + i, ETHERNET[i]);
		for (int i = 0; i < std::size(NETWORK); i++)
			m_nvram->write(0x77c + i, NETWORK[i]);
	}

	// The boot PROM keeps the Ethernet address at $1f2c. Setup only stores the low three bytes, at $779.
	static constexpr uint8_t MOTOROLA_OUI[] = { 0x08, 0x00, 0x3e };
	for (int i = 0; i < 3; i++)
	{
		m_nvram->write(0x1f2c + i, MOTOROLA_OUI[i]);
		m_nvram->write(0x1f2f + i, m_nvram->read(0x779 + i));
	}

	// The CPU takes its reset vectors on its first cycle, so these are what start PSOS.
	address_space &space = m_maincpu->space(AS_PROGRAM);
	space.write_dword(0, PSOS_BASE);
	space.write_dword(4, space.read_dword(PSOS_BASE + 0x9c));
}

void maxine_state::machine_start()
{
	m_fb->set_line_levels(m_line_levels, m_line_level_control);
	m_video_input.allocate(chyron_fb_device::VIDEO_INPUT_WIDTH, chyron_fb_device::VIDEO_INPUT_HEIGHT);
	m_video_input.fill(0);
	m_fb->set_video_input(&m_video_input);

	// SDL turns these into an event that MAME never reads, so a plain kill wouldn't stop the machine.
	// Exiting through the scheduler is what saves the NVRAM.
	std::signal(SIGTERM, request_quit);
	std::signal(SIGINT, request_quit);

	// Scroll Lock is INS ROW, and MAME would also take it as the switch to its own hotkeys, such as Esc to quit
	machine().ioport().set_type_seq(IPT_UI_TOGGLE_UI, 0, SEQ_TYPE_STANDARD, input_seq());

	// For MAXINE! Studio's log field. error.log has no limit, and a stuck chip once wrote 11 GB of it.
	if (std::getenv("MAXINE_LOG_STDOUT"))
	{
#if !defined(__EMSCRIPTEN__)
		// A hard reset comes back through here, and the thread is still reading
		static bool commands_started = false;
		if (!commands_started)
		{
			commands_started = true;
			std::thread(read_commands).detach();
		}
#endif
		// field_tick stops while the machine is paused, and this doesn't
		machine().add_notifier(MACHINE_NOTIFY_FRAME, machine_notify_delegate(&maxine_state::poll_host, this));
#if !defined(_WIN32)
		std::signal(SIGPIPE, SIG_IGN); // losing the app, or a capture, shouldn't lose the machine
#endif
		machine().add_logerror_callback([] (char const *text) { std::fputs(text, stdout); std::fflush(stdout); });
	}

	m_key_timer = timer_alloc(FUNC(maxine_state::key_bit), this);
	m_mouse_timer = timer_alloc(FUNC(maxine_state::mouse_bit), this);
	m_tablet_timer = timer_alloc(FUNC(maxine_state::tablet_bit), this);
	m_field_timer = timer_alloc(FUNC(maxine_state::field_tick), this);
	m_field_timer->adjust(attotime::from_ticks(1001, 60000), 0, attotime::from_ticks(1001, 60000));
#if !defined(__EMSCRIPTEN__)
	m_capture_timer = timer_alloc(FUNC(maxine_state::capture_field), this);
#endif
	m_heartbeat = timer_alloc(FUNC(maxine_state::heartbeat), this);
	m_heartbeat->adjust(attotime::from_seconds(1), 0, attotime::from_seconds(1));
}

void maxine_state::machine_reset()
{
#if defined(_WIN32)
	// Every TAP adapter is listed, and any of them could be a VPN's, so only emulator/net-up.ps1's is
	// used. MAME's saved settings hold an index that may now point at another one.
	int adapter = -1;
	for (auto const &device : machine().osd().list_network_devices())
		if (device.description == "MAXINE Emulator")
			adapter = device.id;
	if (m_lan->get_interface() != adapter)
		m_lan->set_interface(adapter);
#else
	// emulator/net-up.sh's virtual Ethernet, if it's there: feth0 through pcap on a Mac, and on Linux
	// the TAP device. This comes after MAME's saved settings.
	for (auto const &device : machine().osd().list_network_devices())
		if ((device.description == "feth0" || device.description == "TUN/TAP Device") && m_lan->get_interface() != device.id)
			m_lan->set_interface(device.id);
#endif

	boot_stub();
}

static INPUT_PORTS_START(maxine)
	PORT_START("PANEL0")
	MAXINE_PANEL0_BITS

	PORT_START("PANEL1")
	MAXINE_PANEL1_BITS

	PORT_START("PANEL2")
	MAXINE_PANEL2_BITS

	PORT_START("HOSTKEYS")
	PORT_BIT(1, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Command") PORT_CODE(KEYCODE_LWIN) PORT_CODE(KEYCODE_RWIN)
	PORT_BIT(2, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("V") PORT_CODE(KEYCODE_V)
#if defined(_WIN32)
	PORT_BIT(4, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Right Alt") PORT_CODE(KEYCODE_RALT)
#endif

	PORT_START("HOSTSHIFT")
	PORT_BIT(1, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("S-SHIFT") PORT_CODE(KEYCODE_LSHIFT) PORT_CODE(KEYCODE_RSHIFT)

	// Bits match the panel's shift order: CHAR, PAGE, ROW
	PORT_START("HOSTHOLD")
	PORT_BIT(1, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Hold SHIFT CHAR") PORT_CODE(KEYCODE_DEL)
	PORT_BIT(2, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Hold SHIFT PAGE") PORT_CODE(KEYCODE_END)
	PORT_BIT(4, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Hold SHIFT ROW") PORT_CODE(KEYCODE_PGDN)

	PORT_START("EXPORT")
	PORT_BIT(0x01, IP_ACTIVE_HIGH, IPT_OTHER) PORT_NAME("Export Video and Key") PORT_CODE(KEYCODE_RCONTROL)
INPUT_PORTS_END

void maxine_state::maxine(machine_config &config)
{
	// Twice the real clock, because MAME's cycle counts are well above what a 68040 takes
	M68040(config, m_maincpu, 50_MHz_XTAL);
	m_maincpu->set_addrmap(AS_PROGRAM, &maxine_state::maxine_mem);
	m_maincpu->set_addrmap(m68000_musashi_device::AS_CPU_SPACE, &maxine_state::cpu_space_map);

	MCCHIP(config, m_mcc, 0);
	m_mcc->irq_changed().set(FUNC(maxine_state::update_irq));

	SCC85230(config, m_scc[0], 10_MHz_XTAL);
	m_scc[0]->out_int_callback().set(m_mcc, FUNC(mcchip_device::scc_irq_w));
	m_scc[0]->out_txda_callback().set("port1", FUNC(rs232_port_device::write_txd));
	rs232_port_device &port1(RS232_PORT(config, "port1", default_rs232_devices, "null_modem"));
	port1.rxd_handler().set(m_scc[0], FUNC(scc85230_device::rxa_w));

	SCC85230(config, m_scc[1], 10_MHz_XTAL);

	MK48T08(config, m_nvram);

	NSCSI_BUS(config, m_scsi);
	NSCSI_CONNECTOR(config, "scsi:0", default_scsi_devices, "harddisk");
	NSCSI_CONNECTOR(config, "scsi:1", default_scsi_devices, nullptr);
	NSCSI_CONNECTOR(config, "scsi:2", default_scsi_devices, nullptr);
	NSCSI_CONNECTOR(config, "scsi:3", default_scsi_devices, nullptr);
	NSCSI_CONNECTOR(config, "scsi:4", default_scsi_devices, nullptr);
	NSCSI_CONNECTOR(config, "scsi:5", default_scsi_devices, nullptr);
	NSCSI_CONNECTOR(config, "scsi:6", default_scsi_devices, nullptr);

	NCR53C710(config, m_siop, 50_MHz_XTAL);
	m_siop->big_lit_handler().set_constant(1);
	m_siop->irq_handler().set(m_mcc, FUNC(mcchip_device::scsi_irq_w));
	m_siop->host_read().set(FUNC(maxine_state::dma_r));
	m_siop->host_write().set(FUNC(maxine_state::dma_w));
	m_scsi->set_external_device(7, m_siop);

	TMS34010(config, m_prompt, 50_MHz_XTAL);
	m_prompt->set_addrmap(AS_PROGRAM, &maxine_state::prompt_mem);
	m_prompt->set_halt_on_reset(true);
	m_prompt->output_int().set(FUNC(maxine_state::bim_input_w<0>));
	m_prompt->set_pixel_clock(12_MHz_XTAL);
	m_prompt->set_pixels_per_clock(1);
	m_prompt->set_screen("prompt_screen");
	m_prompt->set_scanline_rgb32_callback(FUNC(maxine_state::prompt_scanline));

	CHYRON_FB(config, m_fb, 0);

	// The machine has no audio. MAME warns at launch unless a system has a speaker, so this one is silent.
	SPEAKER(config, "speaker", 1).front_center();

	screen_device &prompt_screen(SCREEN(config, "prompt_screen"));
	prompt_screen.set_raw(13.5_MHz_XTAL, 858, PROMPT_LEFT, PROMPT_RIGHT, 525, PROMPT_TOP, PROMPT_BOTTOM);
	prompt_screen.set_screen_update(FUNC(maxine_state::prompt_update));

	screen_device &edit_screen(SCREEN(config, "edit_screen"));
	edit_screen.set_raw(13.5_MHz_XTAL, 858, EDIT_LEFT, EDIT_RIGHT, 525, EDIT_TOP, EDIT_BOTTOM);
	edit_screen.set_screen_update(FUNC(maxine_state::edit_update));

	I82596_LE32(config, m_lan, 25_MHz_XTAL);
	m_lan->set_addrmap(0, &maxine_state::lan_mem);
	m_lan->set_swap_data(true);
	m_lan->set_add_fcs(true);
	m_lan->out_irq_cb().set(m_mcc, FUNC(mcchip_device::lan_irq_w));
	MC68681(config, m_keyboard_duart, 3.6864_MHz_XTAL);
	m_keyboard_duart->irq_cb().set(FUNC(maxine_state::keyboard_irq_w));

	generic_keyboard_device &keyboard(GENERIC_KEYBOARD(config, "keyboard", 0));
	keyboard.set_keyboard_callback(FUNC(maxine_state::host_key));

	MC68681(config, m_serial_duart, 3.6864_MHz_XTAL);
	m_serial_duart->irq_cb().set(FUNC(maxine_state::bim_input_w<1>));
	MC68901(config, m_mfp, 3.6864_MHz_XTAL);
	m_mfp->out_irq_cb().set(FUNC(maxine_state::mfp_irq_w));
}

ROM_START(maxine)
	ROM_REGION(0x2000, "nvram", ROMREGION_ERASE00)
	// SCSI minor 0, as the disk needs before it can mount: 8 bytes each from 0x0a, log2
	// block size, block count, ID, LUN, type (1 = Seagate)
	ROM_FILL(0x000a, 1, 9)
	ROM_FILL(0x000c, 1, 0x20) // 0x00200000 blocks
	ROM_FILL(0x0011, 1, 1)
	// Serial ports as Setup stores them, baud word, data bits and parity, stop code, so a new machine
	// has no "Serial Ports not initialized" warning: the tablet port at 19200 8O1, then 9600 8N1 for II
	ROM_FILL(0x0218, 1, 0x4b)
	ROM_FILL(0x021a, 1, 0x81)
	ROM_FILL(0x021b, 1, 0x11)
	ROM_FILL(0x021c, 1, 0x25)
	ROM_FILL(0x021d, 1, 0x80)
	ROM_FILL(0x021e, 1, 0x82)
	ROM_FILL(0x021f, 1, 0x03)
	ROM_FILL(0x0262, 1, 1) // serial ports set up, which is all the Loader's warning checks
	ROM_FILL(0x0411, 1, 1) // tablet type: WACOM SD510C, the one the driver emulates
ROM_END

} // anonymous namespace

//    YEAR  NAME    PARENT  COMPAT  MACHINE  INPUT   CLASS         INIT        COMPANY   FULLNAME   FLAGS
COMP( 1995, maxine, 0,      0,      maxine,  maxine, maxine_state, empty_init, "Chyron", "MAXINE!", 0 )
