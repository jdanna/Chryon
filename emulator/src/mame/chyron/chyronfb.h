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
	void render_video(bitmap_rgb32 &bitmap, rectangle const &cliprect, bool faded = true) const;
	void render_key(bitmap_rgb32 &bitmap, rectangle const &cliprect) const;

	// One field of both, every second line of a width x height frame of $KKRRGGBB
	void render_field(uint32_t *frame, unsigned first_line, unsigned width, unsigned height) const;

	// The Video Input board's picture, which it writes into the frame buffer while the control register is live
	static constexpr int VIDEO_INPUT_WIDTH = 720;
	static constexpr int VIDEO_INPUT_HEIGHT = 486;
	bool video_input_live() const { return (m_regs[REG_CONTROL] & (CONTROL_VIDEO_INPUT | CONTROL_GRAPHICS | CONTROL_FREEZE)) == CONTROL_VIDEO_INPUT; }
	void write_video_input(bitmap_rgb32 const &picture, bool keyed);
	void set_video_input(bitmap_rgb32 const *picture) { m_video_input = picture; }

	// The video board's two tables of line levels, and the control word that picks one
	void set_line_levels(uint32_t const *tables, uint32_t const *control) { m_levels = tables; m_level_control = control; }

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
		REG_PIXEL = 0x18 / 4,
		LINES_A = 0x10000 / 4,
		LINES_B = 0x11000 / 4,
		PALETTE = 0x20000 / 4,
		PALETTE_END = 0x22000 / 4,
		LINES_C = 0x30000 / 4
	};

	static constexpr uint32_t CONTROL_RUNS = 0x20; // clear: data port copies whole rows
	static constexpr uint32_t CONTROL_RECORDS = 0x10; // clear with RUNS set: data port writes a pixel
	static constexpr uint32_t CONTROL_BANK = 0x01;
	static constexpr uint32_t CONTROL_VIDEO_BACKGROUND = 0x02; // the Video Input board's picture behind the graphics
	static constexpr uint32_t CONTROL_VIDEO_INPUT = 0x08; // set in every value the Video Input menu uses, unlike the 0 at reset
	static constexpr uint32_t CONTROL_FREEZE = 0x40; // clear with GRAPHICS clear and VIDEO_INPUT set: the Video Input board writes
	static constexpr uint32_t CONTROL_GRAPHICS = 0x400; // set except while Message Compose's Video Input menu is open, or zoomed
	static constexpr unsigned ZOOM_SHIFT = 11; // bits 15..11: horizontal zoom - 2, with GRAPHICS clear. Image Tools' Zoom / Pan goes 1, 3, 4, ... 14
	static constexpr uint32_t CONTROL_MERGE = 0x02000000; // a pixel word merges into the pixel

	// A pixel: palette address and key, and up to two layers underneath, the lowest first
	struct pixel
	{
		uint8_t index;
		uint8_t key;
		uint8_t under;
		uint8_t under_index;
		uint8_t blend;
		uint8_t blend_index;
		uint8_t direct; // use color, already multiplied by key, not the palette
		uint32_t color;
	};

	pixel *row(unsigned y) const { return &m_vram[(y % ROWS) * ROW_PIXELS]; }
	void put(uint32_t data);
	void put_pixel(uint32_t data);
	uint32_t get_pixel();
	void copy_rows(uint32_t data);
	uint32_t palette(unsigned index) const;
	unsigned horizontal_zoom() const;
	pixel const &display_pixel(int y, int x) const;
	void output_pixel(pixel const &p, uint32_t &video, uint8_t &key) const;
	unsigned line_level(int y) const;
	void output(int y, int x, unsigned level, uint32_t &video, uint8_t &key) const;

	std::unique_ptr<pixel[]> m_vram;
	uint32_t m_regs[0x40000];
	unsigned m_x, m_y, m_start_x;
	unsigned m_under, m_under_index, m_blend, m_blend_index, m_copy_row;
	uint32_t const *m_levels = nullptr;
	uint32_t const *m_level_control = nullptr;
	bitmap_rgb32 const *m_video_input = nullptr;
};

DECLARE_DEVICE_TYPE(CHYRON_FB, chyron_fb_device)

#endif // MAME_CHYRON_CHYRONFB_H
