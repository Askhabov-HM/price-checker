package ru.pricechecker.lamoda;

import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;

final class SourceHttp {
    private SourceHttp(){}
    static long retryAfter(String value,long now) {
        if(value==null)return 0;
        String text=value.trim();long limit=365L*86400000;
        try {
            if(text.matches("[0-9]+")) {
                String digits=text.replaceFirst("^0+(?!$)","");
                if(digits.length()>8)return limit;
                return Math.min(limit,Long.parseLong(digits)*1000);
            }
            return Math.min(limit,Math.max(0,ZonedDateTime.parse(text,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()-now));
        }catch(RuntimeException ignored){return 0;}
    }
}
