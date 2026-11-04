// license:BSD-3-Clause
// copyright-holders:Joey D'Anna
/***************************************************************************

    Sends the machine's Video and Key as two NDI sources, a fill and a
    matte, the pair a downstream keyer takes. The NDI runtime is loaded at
    run time, from NDI Tools or the NDI SDK, so a machine without it just
    can't open the output. NDI® is a registered trademark of Vizrt NDI AB.

***************************************************************************/

#ifndef MAME_CHYRON_NDIOUT_H
#define MAME_CHYRON_NDIOUT_H

#pragma once

#include <cstdint>
#include <memory>
#include <string>

class ndi_output
{
public:
	static constexpr unsigned WIDTH = 720;
	static constexpr unsigned HEIGHT = 486;

	// Opens "<name> Fill" and "<name> Matte". If that fails, error() says why and nothing else works.
	explicit ndi_output(std::string const &name);
	~ndi_output();

	std::string const &error() const { return m_error; }

	// A whole interlaced frame of $KKRRGGBB: the fill gets the colour, the matte the key as grey
	void send(uint32_t const *frame);

	// How many receivers each source has
	int fill_receivers() const;
	int matte_receivers() const;

	struct impl;

private:
	std::unique_ptr<impl> m_impl;
	std::string m_error;
};

#endif // MAME_CHYRON_NDIOUT_H
