// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Sends frames of the Video and Key outputs to MAXINE! Studio, which
    encodes them. One pixel is $KKRRGGBB, so each frame carries both outputs
    and the two files that come from them can't drift apart.

***************************************************************************/

#ifndef MAME_CHYRON_FIELDCAPTURE_H
#define MAME_CHYRON_FIELDCAPTURE_H

#pragma once

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

class field_capture
{
public:
	static constexpr unsigned WIDTH = 720;
	static constexpr unsigned HEIGHT = 486;

	explicit field_capture(int port);
	~field_capture(); // sends what's queued, then closes the connection

	// The next frame to fill. Waits if the app is behind, because a capture never drops a field.
	uint32_t *next_frame();
	void submit_frame();

	// The app has gone away, so frames now go nowhere
	bool failed() const { return m_failed; }

private:
	static constexpr unsigned FRAMES = 8; // about a quarter of a second
	static constexpr size_t FRAME_BYTES = WIDTH * HEIGHT * sizeof(uint32_t);

	uint32_t *slot(unsigned index) const { return &m_frames[(index % FRAMES) * WIDTH * HEIGHT]; }
	void send_frames(int port);

	std::unique_ptr<uint32_t[]> m_frames;
	unsigned m_filled = 0, m_sent = 0; // counts, so filled - sent is how many wait
	bool m_closing = false;
	std::atomic<bool> m_failed{false};
	std::mutex m_mutex;
	std::condition_variable m_changed;
	std::thread m_thread;
};

#endif // MAME_CHYRON_FIELDCAPTURE_H
