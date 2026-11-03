// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Plays one of the machine's outputs out of a Blackmagic DeckLink, as
    NTSC 525i59.94 in 8-bit 4:2:2. The DeckLink library comes from the
    Desktop Video driver at run time, so a machine without it just has no
    devices. The SDK's types stay in the .cpp, because its Windows header
    brings windows.h with it.

***************************************************************************/

#ifndef MAME_CHYRON_DECKLINKOUT_H
#define MAME_CHYRON_DECKLINKOUT_H

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class decklink_output
{
public:
	static constexpr unsigned WIDTH = 720;
	static constexpr unsigned HEIGHT = 486;
	static constexpr unsigned ROW_BYTES = WIDTH * 2; // UYVY

	struct listing
	{
		bool driver = false; // whether Desktop Video is installed
		std::vector<std::string> names;
	};

	// Every DeckLink device by its display name, and "dump" when MAXINE_DECKLINK_DUMP names a file
	static listing devices();

	// The list as MAXINE! Studio reads it: a MAXINE_DECKLINK_DEVICE line per device and then
	// MAXINE_DECKLINK_DEVICES with the count, or MAXINE_DECKLINK_NODRIVER
	static std::string report();

	// Opens the device and starts it on black. If that fails, error() says why and nothing else works.
	explicit decklink_output(std::string const &name);
	~decklink_output(); // stops playback, so the device goes back to its idle output

	std::string const &error() const { return m_error; }

	// The next frame to fill, in UYVY. Waits while the device is a few frames ahead, so the device's
	// clock paces the machine when it's the slower one. Null once the device has stopped taking frames.
	uint8_t *next_frame();
	void submit_frame();

	// Frames shown again because the machine was late with the next one
	unsigned repeats() const;

	// One row of $KKRRGGBB as Rec. 601 video, or the key as luma
	static void convert_row(uint32_t const *source, uint8_t *dest, bool key);

	struct impl;

private:
	std::unique_ptr<impl> m_impl;
	std::string m_error;
};

#endif // MAME_CHYRON_DECKLINKOUT_H
