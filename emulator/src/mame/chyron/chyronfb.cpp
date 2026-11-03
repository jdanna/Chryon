// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Chyron frame buffer board

    Worked out from FB_DUAL.X, and the schematics' word formats. There is no
    gate-level model behind this: the board is discrete logic, FIFOs and VRAM.

    +00  control. Bit 5 set: the data port takes run records. Clear: it
         copies whole rows, which is how the driver fills large areas. Bits
         2..0 flip the displayed bank of up to three boards. Bits 15..11 with
         bit 10 clear: horizontal zoom - 2, each pixel repeated. Image Tools'
         Zoom / Pan pairs it with a line table that repeats each row as often,
         so the picture scales from its top left.
    +04  colour number, selecting a palette bank: 0 black, 1 green, 2 blue, 3 cyan,
         4 red, 5 yellow, 6 magenta, 7 white
    +08  address, row << 10 | x. 2048 rows: two banks of 1024
    +0c  data port
    +18  pixel port: reads back pixels from the address, moving along the row. The driver
         copies a page to the other bank this way when a roll is armed
    $10000, $11000  line tables, 1024 longs each, for banks A and B: row * $800 + x for
                    each display line. A roll changes the row and a crawl changes x
    $30000  a third table, purpose unknown

    The video board's line levels, which fade the outputs, are kept by the
    driver and read here. See line_level().
    $20000  palette, 8 banks of 32 at bank << 8 | ramp

    A run record is a word of a font file: layer in the top 16 bits, intensity
    in bits 15..8, then (32 - length) << 3 | type. Type 0 skips, 1 and 2 draw,
    3 ends the row. The layer picks the palette entry within the bank: 1 is
    the 75% colour for the face, 2 the 50% one for the edge. The intensity is
    the key. A layer with bit 15 set is a value for the pixel under the next
    record, without moving on: $8002 is the edge, and a texture's shading puts
    a second ramp entry there too, blending with the face's.

    With control bit 4 clear, each word is one pixel instead: $KKBBGGRR, the
    key and a full colour that bypasses the palette, already multiplied by the
    key. The Palette tool's bars and chips are drawn this way, and so are Logo
    Compose's outlines. With bit 25 set as well, a word merges into the pixel.

***************************************************************************/

#include "emu.h"
#include "chyronfb.h"

#include "screen.h"

#define VERBOSE 0
#include "logmacro.h"

DEFINE_DEVICE_TYPE(CHYRON_FB, chyron_fb_device, "chyron_fb", "Chyron Frame Buffer")

chyron_fb_device::chyron_fb_device(const machine_config &mconfig, const char *tag, device_t *owner, uint32_t clock)
	: device_t(mconfig, CHYRON_FB, tag, owner, clock)
	, m_x(0), m_y(0), m_start_x(0), m_under(0), m_under_index(0), m_blend(0), m_blend_index(0), m_copy_row(0)
{
}

void chyron_fb_device::device_start()
{
	m_vram = std::make_unique<pixel[]>(ROWS * ROW_PIXELS);
	memset(m_regs, 0, sizeof(m_regs));

	save_pointer(reinterpret_cast<uint8_t *>(m_vram.get()), "vram", ROWS * ROW_PIXELS * sizeof(pixel));
	save_item(NAME(m_regs));
	save_item(NAME(m_x));
	save_item(NAME(m_y));
	save_item(NAME(m_start_x));
	save_item(NAME(m_under));
	save_item(NAME(m_under_index));
	save_item(NAME(m_blend));
	save_item(NAME(m_blend_index));
	save_item(NAME(m_copy_row));
}

void chyron_fb_device::device_reset()
{
}

// The other registers are write-only and float high, which is how HWINIT tells this board from an Anchor
uint32_t chyron_fb_device::read(offs_t offset, uint32_t mem_mask)
{
	if (offset >= PALETTE && offset < PALETTE_END)
		return m_regs[offset];
	if (offset == REG_PIXEL)
		return get_pixel();
	return 0xffffffff;
}

void chyron_fb_device::write(offs_t offset, uint32_t data, uint32_t mem_mask)
{
	switch (offset)
	{
	case REG_ADDRESS:
		m_start_x = m_x = BIT(data, 0, 10);
		m_y = data >> 10;
		break;

	case REG_DATA:
		if (!(m_regs[REG_CONTROL] & CONTROL_RUNS))
			copy_rows(data);
		else if (m_regs[REG_CONTROL] & CONTROL_RECORDS)
			put(data);
		else
			put_pixel(data);
		break;

	default:
		COMBINE_DATA(&m_regs[offset & (std::size(m_regs) - 1)]);
		break;
	}
}

void chyron_fb_device::put(uint32_t data)
{
	if (!data)
		return;

	unsigned const layer = data >> 16;
	unsigned const intensity = BIT(data, 8, 8);
	unsigned const length = 32 - BIT(data, 3, 5);
	unsigned const type = data & 3;

	if (type == 3)
	{
		m_x = m_start_x;
		m_y++;
		return;
	}
	if (type == 0)
	{
		m_x += length;
		return;
	}
	unsigned const color = m_regs[REG_COLOR] << 5;
	if (layer & 0x8000)
	{
		// A texture's shading stacks a ramp entry on the edge, so the first is underneath and the next above it
		bool const first = !m_under;
		(first ? m_under : m_blend) = intensity;
		(first ? m_under_index : m_blend_index) = color | (layer & 0x1f);
		return;
	}

	pixel *const dest = row(m_y);
	for (unsigned i = 0; i < length; i++)
	{
		pixel &p = dest[(m_x + i) % ROW_PIXELS];
		p.direct = 0;
		if (layer == 0)
		{
			// A fill: the intensity byte is a palette address
			p.index = intensity;
			p.key = intensity ? 0xff : 0;
			p.under = 0;
			p.blend = 0;
		}
		else
		{
			p.index = color | (layer & 0x1f);
			p.key = intensity;
			p.under = m_under;
			p.under_index = m_under_index;
			p.blend = m_blend;
			p.blend_index = m_blend_index;
		}
		m_under = m_blend = 0;
	}
	m_x += length;
}

// A pixel in full colour, without the palette: $KKBBGGRR, in the palette's byte order. Logo Compose
// strokes lines by overlapping 3x3 dabs of levels 7, $1f and $7f, with bit 25 set, and each would
// erase its neighbour's brighter centre if it replaced the pixel. Those levels are 2^n-1, so OR and
// max give the same result. Which the board does isn't known, and adding them would look brighter.
void chyron_fb_device::put_pixel(uint32_t data)
{
	pixel &p = row(m_y)[m_x++ % ROW_PIXELS];
	bool const merge = p.direct && (m_regs[REG_CONTROL] & CONTROL_MERGE);
	p.color = (merge ? p.color : 0) | (swapendian_int32(data) >> 8);
	p.key = (merge ? p.key : 0) | (data >> 24);
	p.direct = 1;
	p.under = 0;
	p.blend = 0;
}

// In the form put_pixel takes, because the driver writes these straight back to the other bank
uint32_t chyron_fb_device::get_pixel()
{
	uint32_t video;
	uint8_t key;
	output_pixel(row(m_y)[m_x % ROW_PIXELS], video, key);
	if (!machine().side_effects_disabled())
		m_x++;
	return uint32_t(key) << 24 | swapendian_int32(video) >> 8;
}

// Data 3 latches the addressed row, then each record's length is that many rows filled from it
void chyron_fb_device::copy_rows(uint32_t data)
{
	if ((data & 7) == 3)
	{
		m_copy_row = m_y;
		return;
	}
	unsigned const length = 32 - BIT(data, 3, 5);
	for (unsigned i = 0; i < length; i++)
	{
		memcpy(row(m_y), row(m_copy_row), ROW_PIXELS * sizeof(pixel));
		m_y++;
	}
}

uint32_t chyron_fb_device::palette(unsigned index) const
{
	return swapendian_int32(m_regs[PALETTE + (BIT(index, 5, 3) << 8) + (index & 0x1f)]) >> 8; // stored as BGR
}

static uint32_t mix(uint32_t under, uint32_t over, unsigned key)
{
	if (key == 0xff)
		return over;
	unsigned const r = (BIT(over, 16, 8) * key + BIT(under, 16, 8) * (255 - key)) / 255;
	unsigned const g = (BIT(over, 8, 8) * key + BIT(under, 8, 8) * (255 - key)) / 255;
	unsigned const b = (BIT(over, 0, 8) * key + BIT(under, 0, 8) * (255 - key)) / 255;
	return (r << 16) | (g << 8) | b;
}

// Image Tools' Zoom / Pan sets the zoom level less 2 in bits 15..11 and clears bit 10, after
// writing a line table that repeats each row that many times, 3 to 14. The board repeats pixels
// to match. Level 1 sets bit 10 again, and the firmware never asks for 2, whose control value
// would be the Video Input menu's.
unsigned chyron_fb_device::horizontal_zoom() const
{
	uint32_t const control = m_regs[REG_CONTROL];
	unsigned const zoom = BIT(control, ZOOM_SHIFT, 5);
	return (control & CONTROL_GRAPHICS) || !zoom ? 1 : zoom + 2;
}

// The bank being drawn is hidden: the driver writes one, flips, then repeats on the other. Each bank has
// its own line table, whose entries are row << 11 | x. A crawl only moves the x of its lines, with the
// hidden table 720 behind, as x + 1328 of 2048. Its x then wraps to 0 just where the shown strip runs
// out, so that's where the picture continues from the other bank. Text moves through 720-pixel strips,
// one in each bank. Which logic does this on the board isn't known.
chyron_fb_device::pixel const &chyron_fb_device::display_pixel(int y, int x) const
{
	static constexpr unsigned LINE_X_SIZE = 0x800;

	bool const bank = m_regs[REG_CONTROL] & CONTROL_BANK;
	uint32_t const shown = m_regs[(bank ? LINES_B : LINES_A) + y];
	uint32_t const hidden = m_regs[(bank ? LINES_A : LINES_B) + y];
	x /= horizontal_zoom();
	unsigned const next = (hidden & (LINE_X_SIZE - 1)) + x;
	if (next >= LINE_X_SIZE && hidden != shown) // equal tables only shift the line, as Video Input's x of 2047 does
		return row((hidden >> 11) + (bank ? 0 : ROWS / 2))[next - LINE_X_SIZE];
	return row((shown >> 11) + (bank ? ROWS / 2 : 0))[((shown & (LINE_X_SIZE - 1)) + x) % ROW_PIXELS];
}

// Video and key before the key is applied: colour over black, and the matte
void chyron_fb_device::output_pixel(pixel const &p, uint32_t &video, uint8_t &key) const
{
	uint32_t out = 0;
	unsigned k = p.under;
	if (p.under)
		out = mix(0, palette(p.under_index), p.under);
	if (p.blend)
	{
		out = mix(out, palette(p.blend_index), p.blend);
		k = 255 - (255 - k) * (255 - p.blend) / 255;
	}
	if (p.key)
	{
		out = p.direct ? p.color + mix(out, 0, p.key) : mix(out, palette(p.index), p.key);
		k = 255 - (255 - k) * (255 - p.key) / 255;
	}
	video = out;
	key = k;
}

// Message Compose's Video Input menu clears control bits 10 and 6 for live video, with bit 3 set as in all its
// values, which keeps the 0 the register holds from reset from meaning live. It sets bit 6 again for Video Freeze, which leaves the last picture there. While live, the firmware points every line 2 rows up and 1 pixel left
// (x 2047), presumably where the board writes, and Freeze sets the tables back to identity, so the frozen picture
// sits that much up and left of the live one. While bit 10
// is clear the picture shows as it is. Afterwards it's part of the graphics only if Key Enable was on, because
// otherwise its key is 0. The Gain, Black and Delay settings aren't modelled, nor is the Field setting.
void chyron_fb_device::write_video_input(bitmap_rgb32 const &picture, bool keyed)
{
	static constexpr unsigned LINE_X_SIZE = 0x800;

	// Into both banks, because Message Compose redraws each row of text in one and then the other
	uint32_t const *const lines = &m_regs[(m_regs[REG_CONTROL] & CONTROL_BANK) ? LINES_B : LINES_A];
	for (int y = 0; y < picture.height(); y++)
	{
		unsigned const line_row = (lines[y] >> 11) % (ROWS / 2);
		unsigned const line_x = lines[y] & (LINE_X_SIZE - 1);
		for (unsigned bank = 0; bank < 2; bank++)
		{
			pixel *const dest = row(line_row + bank * ROWS / 2);
			for (int x = 0; x < picture.width(); x++)
			{
				pixel &p = dest[(line_x + x) % ROW_PIXELS];
				p.color = picture.pix(y, x) & 0xffffff;
				p.key = keyed ? 0xff : 0;
				p.direct = 1;
				p.under = 0;
				p.blend = 0;
			}
		}
	}
}

// The video board scales each display line by a 7-bit level, bits 15..9 of its entry in one of two tables
// at $81200000 and $81201000. Bit 21 of its control word at $81202000 shows the second. Message Compose's
// Fade steps the level between 127 and 0, writing the hidden table and then flipping that bit. Video is
// already multiplied by the key, so it fades with it. The rest of each entry is unexplained.
static constexpr unsigned LEVEL_FULL = 127;

unsigned chyron_fb_device::line_level(int y) const
{
	if (!m_levels)
		return LEVEL_FULL;
	return BIT(m_levels[(BIT(*m_level_control, 21) ? 0x1000 / 4 : 0) + y], 9, 7);
}

static void apply_level(uint32_t &video, uint8_t &key, unsigned level);

// One display pixel of Video and Key. With control bit 10 clear, the Video Input menu's frame store, a picture shows
// as it is. Otherwise the graphics are keyed, after the line's level, and control bit 1, Message Compose's ALT V,
// puts the video input behind them. Key is the graphics' alone either way.
void chyron_fb_device::output(int y, int x, unsigned level, uint32_t &video, uint8_t &key) const
{
	uint32_t const control = m_regs[REG_CONTROL];
	pixel const &p = display_pixel(y, x);
	if (!(control & CONTROL_GRAPHICS) && !BIT(control, ZOOM_SHIFT, 5) && p.direct)
	{
		video = p.color;
		key = p.key;
	}
	else
		output_pixel(p, video, key);
	apply_level(video, key, level);
	if ((control & (CONTROL_GRAPHICS | CONTROL_VIDEO_BACKGROUND)) == (CONTROL_GRAPHICS | CONTROL_VIDEO_BACKGROUND) && m_video_input)
		video += mix(0, m_video_input->pix(y, x), 255 - key); // graphics are already multiplied by their key
}

static void apply_level(uint32_t &video, uint8_t &key, unsigned level)
{
	if (level == LEVEL_FULL)
		return;
	unsigned const r = BIT(video, 16, 8) * level / LEVEL_FULL;
	unsigned const g = BIT(video, 8, 8) * level / LEVEL_FULL;
	unsigned const b = BIT(video, 0, 8) * level / LEVEL_FULL;
	video = (r << 16) | (g << 8) | b;
	key = key * level / LEVEL_FULL;
}

void chyron_fb_device::render_video(bitmap_rgb32 &bitmap, rectangle const &cliprect, bool faded) const
{
	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		uint32_t *const dest = &bitmap.pix(y);
		unsigned const level = faded ? line_level(y) : LEVEL_FULL;
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			uint8_t key;
			output(y, x, level, dest[x], key);
		}
	}
}

void chyron_fb_device::render_key(bitmap_rgb32 &bitmap, rectangle const &cliprect) const
{
	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		uint32_t *const dest = &bitmap.pix(y);
		unsigned const level = line_level(y);
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			uint32_t video;
			uint8_t key;
			output(y, x, level, video, key);
			dest[x] = (key << 16) | (key << 8) | key;
		}
	}
}

void chyron_fb_device::render_field(uint32_t *frame, unsigned first_line, unsigned width, unsigned height) const
{
	for (unsigned y = first_line; y < height; y += 2)
	{
		uint32_t *const dest = &frame[y * width];
		unsigned const level = line_level(y);
		for (unsigned x = 0; x < width; x++)
		{
			uint32_t video;
			uint8_t key;
			output(y, x, level, video, key);
			dest[x] = uint32_t(key) << 24 | (video & 0xffffff);
		}
	}
}
