// license:BSD-3-Clause
// copyright-holders:Joey D'Anna

#include "emu.h"
#include "fieldcapture.h"

#include "osdfile.h"

#include <string>

field_capture::field_capture(int port)
	: m_frames(std::make_unique<uint32_t[]>(FRAMES * WIDTH * HEIGHT))
	, m_thread(&field_capture::send_frames, this, port)
{
}

field_capture::~field_capture()
{
	{
		std::lock_guard<std::mutex> const lock(m_mutex);
		m_closing = true;
	}
	m_changed.notify_all();
	m_thread.join();
}

uint32_t *field_capture::next_frame()
{
	std::unique_lock<std::mutex> lock(m_mutex);
	m_changed.wait(lock, [this] { return m_filled - m_sent < FRAMES || m_failed; });
	return slot(m_filled);
}

void field_capture::submit_frame()
{
	{
		std::lock_guard<std::mutex> const lock(m_mutex);
		m_filled++;
	}
	m_changed.notify_all();
}

// Only this thread touches the socket, so a slow disk at the far end never holds a field up until
// the queue has filled. MAME's socket file is the same code on all three platforms.
void field_capture::send_frames(int port)
{
	osd_file::ptr socket;
	std::uint64_t size;
	bool failed = bool(osd_file::open("socket.127.0.0.1:" + std::to_string(port), OPEN_FLAG_WRITE, socket, size));

	std::unique_lock<std::mutex> lock(m_mutex);
	while (true)
	{
		m_changed.wait(lock, [this] { return m_filled != m_sent || m_closing; });
		if (m_filled == m_sent)
			break;

		uint8_t const *data = reinterpret_cast<uint8_t const *>(slot(m_sent));
		lock.unlock();
		size_t left = FRAME_BYTES;
		while (left && !failed)
		{
			std::uint32_t actual = 0;
			failed = bool(socket->write(data, 0, left, actual)) || !actual;
			data += actual;
			left -= actual;
		}
		lock.lock();

		m_sent++;
		m_failed = failed;
		m_changed.notify_all();
	}
}
