// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Chyron frame buffer board

    Worked out from FB_DUAL.X, and the schematics' word formats. There is no
    gate-level model behind this: the board is discrete logic, FIFOs and VRAM.

    +00  control. Bit 5 set: the data port takes run records. Clear: it
         copies whole rows, which is how the driver fills large areas. Bits
         2..0 flip the displayed bank of up to three boards.
    +04  colour number, selecting a palette bank: 0 black, 1 green, 2 blue, 3 cyan,
         4 red, 5 yellow, 6 magenta, 7 white
    +08  address, row << 10 | x. 2048 rows: two banks of 1024
    +0c  data port
    $10000, $11000  line tables, 1024 longs each: row * $800 for each display line
    $30000  a third table, purpose unknown
    $20000  palette, 8 banks of 32 at bank << 8 | ramp

    A run record is a word of a font file: layer in the top 16 bits, intensity
    in bits 15..8, then (32 - length) << 3 | type. Type 0 skips, 1 and 2 draw,
    3 ends the row. The layer picks the palette entry within the bank: 1 is
    the 75% colour for the face, 2 the 50% one for the edge. The intensity is
    the key. Layer $8002 is an edge value for the pixel under the next record,
    without moving on.

    With control bit 4 clear, Logo Compose writes one pixel per word instead.

***************************************************************************/

#include "emu.h"
#include "chyronfb.h"

#include "screen.h"

#define VERBOSE 0
#include "logmacro.h"

DEFINE_DEVICE_TYPE(CHYRON_FB, chyron_fb_device, "chyron_fb", "Chyron Frame Buffer")

chyron_fb_device::chyron_fb_device(const machine_config &mconfig, const char *tag, device_t *owner, uint32_t clock)
	: device_t(mconfig, CHYRON_FB, tag, owner, clock)
	, m_x(0), m_y(0), m_start_x(0), m_under(0), m_copy_row(0)
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
	save_item(NAME(m_copy_row));
}

void chyron_fb_device::device_reset()
{
}

// Registers are write-only and float high, which is how HWINIT tells this board from an Anchor
uint32_t chyron_fb_device::read(offs_t offset, uint32_t mem_mask)
{
	if (offset >= PALETTE && offset < PALETTE_END)
		return m_regs[offset];
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
	if (layer == 0x8002)
	{
		m_under = intensity;
		return;
	}

	unsigned const color = m_regs[REG_COLOR] << 5;
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
		}
		else
		{
			p.index = color | (layer & 0x1f);
			p.key = intensity;
			p.under = m_under;
			p.under_index = color | 2;
		}
		m_under = 0;
	}
	m_x += length;
}

// Logo Compose's antialiased outlines: the top byte of each word is the level of one pixel. It leaves
// the palette empty, so these show as they are, in white, which is a guess at the real board.
void chyron_fb_device::put_pixel(uint32_t data)
{
	pixel &p = row(m_y)[m_x++ % ROW_PIXELS];
	p.direct = 1;
	p.key = data >> 24;
	p.under = 0;
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

// The bank being drawn is hidden: the driver writes one, flips, then repeats on the other
chyron_fb_device::pixel const *chyron_fb_device::display_row(int y) const
{
	unsigned const bank = (m_regs[REG_CONTROL] & CONTROL_BANK) ? ROWS / 2 : 0;
	return row((m_regs[LINES_A + y] >> 11) + bank);
}

// Video and key before the key is applied: colour over black, and the matte
void chyron_fb_device::output_pixel(pixel const &p, uint32_t &video, uint8_t &key) const
{
	uint32_t out = 0;
	unsigned k = p.under;
	if (p.under)
		out = mix(0, palette(p.under_index), p.under);
	if (p.key)
	{
		out = mix(out, p.direct ? 0xffffff : palette(p.index), p.key);
		k = 255 - (255 - k) * (255 - p.key) / 255;
	}
	video = out;
	key = k;
}

void chyron_fb_device::render_video(bitmap_rgb32 &bitmap, rectangle const &cliprect) const
{
	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		pixel const *const src = display_row(y);
		uint32_t *const dest = &bitmap.pix(y);
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			uint8_t key;
			output_pixel(src[x], dest[x], key);
		}
	}
}

void chyron_fb_device::render_key(bitmap_rgb32 &bitmap, rectangle const &cliprect) const
{
	for (int y = cliprect.min_y; y <= cliprect.max_y; y++)
	{
		pixel const *const src = display_row(y);
		uint32_t *const dest = &bitmap.pix(y);
		for (int x = cliprect.min_x; x <= cliprect.max_x; x++)
		{
			uint32_t video;
			uint8_t key;
			output_pixel(src[x], video, key);
			dest[x] = (key << 16) | (key << 8) | key;
		}
	}
}
