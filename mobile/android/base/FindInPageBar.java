/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko;

import org.mozilla.gecko.util.GeckoEventListener;
import org.mozilla.gecko.util.GeckoRequest;
import org.mozilla.gecko.util.NativeJSObject;
import org.mozilla.gecko.util.ThreadUtils;

import org.json.JSONObject;

import android.content.Context;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.AttributeSet;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;
import android.widget.TextView;

public class FindInPageBar extends LinearLayout implements TextWatcher, View.OnClickListener, GeckoEventListener  {
    private static final String REQUEST_ID = "FindInPageBar";

    private final Context mContext;
    private CustomEditText mFindText;
    private TextView mStatusText;
    private boolean mInflated;

    public FindInPageBar(Context context, AttributeSet attrs) {
        super(context, attrs);
        mContext = context;
        setFocusable(true);
    }

    public void inflateContent() {
        LayoutInflater inflater = LayoutInflater.from(mContext);
        View content = inflater.inflate(R.layout.find_in_page_content, this);

        content.findViewById(R.id.find_prev).setOnClickListener(this);
        content.findViewById(R.id.find_next).setOnClickListener(this);
        content.findViewById(R.id.find_close).setOnClickListener(this);

        // Capture clicks on the rest of the view to prevent them from
        // leaking into other views positioned below.
        content.setOnClickListener(this);

        mFindText = (CustomEditText) content.findViewById(R.id.find_text);
        mFindText.addTextChangedListener(this);
        mFindText.setOnKeyPreImeListener(new CustomEditText.OnKeyPreImeListener() {
            @Override
            public boolean onKeyPreIme(View v, int keyCode, KeyEvent event) {
                if (keyCode == KeyEvent.KEYCODE_BACK) {
                    hide();
                    return true;
                }
                return false;
            }
        });

        mStatusText = (TextView) content.findViewById(R.id.find_status);

        mInflated = true;
        EventDispatcher.getInstance().registerGeckoThreadListener(this, "TextSelection:Data");
    }

    public void show() {
        if (!mInflated)
            inflateContent();

        setVisibility(VISIBLE);
        mFindText.requestFocus();

        // handleMessage() receives response message and determines initial state of softInput
        GeckoAppShell.sendEventToGecko(GeckoEvent.createBroadcastEvent("TextSelection:Get", REQUEST_ID));
        GeckoAppShell.sendEventToGecko(GeckoEvent.createBroadcastEvent("FindInPage:Opened", null));
    }

    public void hide() {
        setVisibility(GONE);
        getInputMethodManager(mFindText).hideSoftInputFromWindow(mFindText.getWindowToken(), 0);
        GeckoAppShell.sendEventToGecko(GeckoEvent.createBroadcastEvent("FindInPage:Closed", null));
    }

    private InputMethodManager getInputMethodManager(View view) {
        Context context = view.getContext();
        return (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
     }

    public void onDestroy() {
        if (!mInflated) {
            return;
        }
        EventDispatcher.getInstance().unregisterGeckoThreadListener(this, "TextSelection:Data");
    }

    // TextWatcher implementation

    @Override
    public void afterTextChanged(Editable s) {
        sendRequestToFinderHelper("FindInPage:Find", s.toString());
    }

    @Override
    public void beforeTextChanged(CharSequence s, int start, int count, int after) {
        // ignore
    }

    @Override
    public void onTextChanged(CharSequence s, int start, int before, int count) {
        // ignore
    }

    // View.OnClickListener implementation

    @Override
    public void onClick(View v) {
        final int viewId = v.getId();

        if (viewId == R.id.find_prev) {
            sendRequestToFinderHelper("FindInPage:Prev", mFindText.getText().toString());
            getInputMethodManager(mFindText).hideSoftInputFromWindow(mFindText.getWindowToken(), 0);
            return;
        }

        if (viewId == R.id.find_next) {
            sendRequestToFinderHelper("FindInPage:Next", mFindText.getText().toString());
            getInputMethodManager(mFindText).hideSoftInputFromWindow(mFindText.getWindowToken(), 0);
            return;
        }

        if (viewId == R.id.find_close) {
            hide();
        }
    }

    // GeckoEventListener implementation

    @Override
    public void handleMessage(String event, JSONObject message) {
        if (!event.equals("TextSelection:Data") || !REQUEST_ID.equals(message.optString("requestId"))) {
            return;
        }

        final String text = message.optString("text");

        // Populate an initial find string, virtual keyboard not required.
        if (!TextUtils.isEmpty(text)) {
            // Populate initial selection
            ThreadUtils.postToUiThread(new Runnable() {
                @Override
                public void run() {
                    mFindText.setText(text);
                }
            });
            return;
        }

        // Show the virtual keyboard.
        if (mFindText.hasWindowFocus()) {
            getInputMethodManager(mFindText).showSoftInput(mFindText, 0);
        } else {
            // showSoftInput won't work until after the window is focused.
            mFindText.setOnWindowFocusChangeListener(new CustomEditText.OnWindowFocusChangeListener() {
                @Override
                public void onWindowFocusChanged(boolean hasFocus) {
                    if (!hasFocus)
                        return;

                    mFindText.setOnWindowFocusChangeListener(null);
                    getInputMethodManager(mFindText).showSoftInput(mFindText, 0);
               }
            });
        }
    }

    /**
     * Request find operation, and update matchCount results (current count and total).
     */
    private void sendRequestToFinderHelper(String request, String searchString) {
        GeckoAppShell.sendRequestToGecko(new GeckoRequest(request, searchString) {
            @Override
            public void onResponse(NativeJSObject nativeJSObject) {
                final int total = nativeJSObject.optInt("total", 0);
                final int current = nativeJSObject.optInt("current", 0);

                final Boolean statusVisibility = (total > 0);
                final String statusText = current + "/" + total;

                ThreadUtils.postToUiThread(new Runnable() {
                    @Override
                    public void run() {
                        mStatusText.setVisibility(statusVisibility ? View.VISIBLE : View.GONE);
                        mStatusText.setText(statusText);
                    }
                });
            }
        });
    }
}
