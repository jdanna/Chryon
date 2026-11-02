// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Chyron frame buffer board

    Takes the same run records as MAXINE font files. See docs/hardware-map.md.

***************************************************************************/

#ifndef MAME_CHYRON_CHYRONFB_H
#define MAME_CHYRON_CHYRONFB_H

#pragma once

class chyron_fb_device : public device_t
{
public:
	chyron_fb_device(const machine_config &mconfig, const char *tag, device_t *owner, uint32_t clock);

	uint32_t read(offs_t offset, uint32_t mem_mask);
	void write(offs_t offset, uint32_t data, uint32_t mem_mask);

	// The board's clean outputs: the Video and Key channels
	void render_video(bitmap_rgb32 &bitmap, rectangle const &cliprect) const;
	void render_key(bitmap_rgb32 &bitmap, rectangle const &cliprect) const;

protected:
	virtual void device_start() override ATTR_COLD;
	virtual void device_reset() override ATTR_COLD;

private:
	static constexpr unsigned ROW_PIXELS = 1024;
	static constexpr unsigned ROWS = 2048;

	enum
	{
		REG_CONTROL = 0x00 / 4,
		REG_COLOR = 0x04 / 4,
		REG_ADDRESS = 0x08 / 4,
		REG_DATA = 0x0c / 4,
		LINES_A = 0x10000 / 4,
		LINES_B = 0x11000 / 4,
		PALETTE = 0x20000 / 4,
		PALETTE_END = 0x22000 / 4,
		LINES_C = 0x30000 / 4
	};

	static constexpr uint32_t CONTROL_RUNS = 0x20; // clear: data port copies whole rows
	static constexpr uint32_t CONTROL_RECORDS = 0x10; // clear with RUNS set: data port writes a pixel
	static constexpr uint32_t CONTROL_BANK = 0x01;
	static constexpr uint32_t CONTROL_MERGE = 0x02000000; // a pixel word merges into the pixel

	// A pixel: palette address and key, and the same for an edge underneath
	struct pixel
	{
		uint8_t index;
		uint8_t key;
		uint8_t under;
		uint8_t under_index;
		uint8_t direct; // use color, already multiplied by key, not the palette
		uint32_t color;
	};

	pixel *row(unsigned y) const { return &m_vram[(y % ROWS) * ROW_PIXELS]; }
	void put(uint32_t data);
	void put_pixel(uint32_t data);
	void copy_rows(uint32_t data);
	uint32_t palette(unsigned index) const;
	pixel const *display_row(int y) const;
	void output_pixel(pixel const &p, uint32_t &video, uint8_t &key) const;

	std::unique_ptr<pixel[]> m_vram;
	uint32_t m_regs[0x40000];
	unsigned m_x, m_y, m_start_x;
	unsigned m_under, m_copy_row;
};

DECLARE_DEVICE_TYPE(CHYRON_FB, chyron_fb_device)

#endif // MAME_CHYRON_CHYRONFB_H
